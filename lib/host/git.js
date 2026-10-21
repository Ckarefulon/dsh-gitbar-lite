/**
 * Git process layer.
 *
 * Everything this plugin knows about a repository comes through here, and every
 * command goes through `ctx.subprocess` rather than `node:child_process`:
 *
 *   - the harness resolves the executable for us (`resolveExecutable` checks an
 *     absolute path exists, walks the scrubbed PATH for a bare name, and
 *     rejects a relative path with separators);
 *   - the child is contained (a Windows Job object here), gets a bounded output
 *     buffer with spill, and is killed through `graceMs` rather than leaking;
 *   - the environment is scrubbed of `*TOKEN*`/`*SECRET*`-shaped variables
 *     before we even add ours.
 *
 * The environment we add on top is the one `@deepseek-ai/dsh-workspace-changes`
 * uses for the same job: no terminal prompt (a credential prompt would hang a
 * headless child forever), no optional index locks, no user config in the way,
 * and a stable locale so the output we parse is the output we expect.
 *
 * Note the documented boundary: the harness file sandbox wraps the *shell*
 * executors (pwsh/bash), not this service. A git child therefore runs with the
 * OS user's full rights. That is why every path this plugin passes to git is
 * derived from a repository root the host itself resolved, never from a raw
 * client string.
 *
 * @module dsh-lite-git/host/git
 */

import { ERROR_CODES, GIT_ENV } from '../shared.js'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000

/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024

/** Default stdout ceiling for one command; diffs go through a larger cap. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** `git rev-parse` exits 128 when the directory is not inside a repository. */
export const NOT_A_REPOSITORY_EXIT = 128

/** The one stderr signature that means "not a repository" rather than "broken". */
const NOT_A_REPOSITORY = /not a git repository/i

/**
 * A git command that ran and failed, carrying the command and its output.
 *
 * Kept distinct from a spawn/timeout failure so callers can classify the
 * message (a conflict, a rejected push, a missing credential) without
 * re-parsing a generic error string.
 */
export class GitFailure extends Error {
  /**
   * @param {string} command the human-readable command, e.g. `git commit`
   * @param {{ exitCode: number | null, stdout: string, stderr: string }} result
   */
  constructor(command, result) {
    const detail = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim()
    super(detail === '' ? `${command} failed (exit ${result.exitCode})` : `${command} failed: ${detail}`)
    this.name = 'GitFailure'
    this.command = command
    this.exitCode = result.exitCode
    this.stdout = result.stdout
    this.stderr = result.stderr
  }
}

/**
 * Why a command ended without a verdict, when the reason was cancellation.
 *
 * Used for both ways a command can be cancelled — before the child exists (the
 * provider refuses the spec synchronously) and after it starts — so that the two
 * report the same sentence instead of one of them reading as an internal error.
 *
 * @param {AbortSignal | undefined} signal the combined signal handed to `spawn`
 * @param {AbortSignal | undefined} timeout our own deadline, when one was set
 * @param {number} timeoutMs that deadline in milliseconds, for the message
 * @returns {string | undefined} the reason, or `undefined` when nothing aborted
 */
function abortReason(signal, timeout, timeoutMs) {
  if (signal === undefined || !signal.aborted) return undefined
  return timeout !== undefined && timeout.aborted ? `timed out after ${timeoutMs}ms` : 'was aborted'
}

/**
 * Build the git runner for one plugin instance.
 *
 * @param {object} ctx host context (must have `subprocess` injected)
 * @param {object} config resolved plugin config
 */
export function createGit(ctx, config) {
  /** Resolved once per plugin instance: the executable cannot change under us. */
  let resolved

  /**
   * Resolve the git executable, honouring an explicit `gitPath` override.
   *
   * A failure here is tagged with `E_NO_GIT` so the route layer reports "git is
   * not installed (or the configured path is wrong)" rather than a generic
   * internal error the user cannot act on.
   *
   * @returns {Promise<string>} absolute path to the executable
   */
  async function executable(signal) {
    if (resolved !== undefined) return resolved
    const configured = typeof config.gitPath === 'string' ? config.gitPath.trim() : ''
    const name = configured === '' ? 'git' : configured
    try {
      resolved = await ctx.subprocess.resolveExecutable(name, undefined, signal)
    } catch (error) {
      const wrapped = new Error(
        configured === ''
          ? `找不到 git 可执行文件：${String(error?.message ?? error)}`
          : `配置的 git 路径不可用（${configured}）：${String(error?.message ?? error)}`,
      )
      wrapped.code = ERROR_CODES.NO_GIT
      throw wrapped
    }
    return resolved
  }

  /**
   * Run one git command.
   *
   * Never throws for a non-zero exit code — that is data, and callers use `ok()`
   * when they want it to be an error. Throws only when the child could not be
   * started, or when the timeout/abort fired.
   *
   * @param {readonly string[]} args arguments after the executable
   * @param {object} [options]
   * @param {string} [options.cwd] working directory (must be an absolute path)
   * @param {AbortSignal} [options.signal] caller's cancellation
   * @param {string} [options.stdin] text written to the child's stdin
   * @param {number} [options.maxBytes] stdout ceiling for this command
   * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, truncated: boolean }>}
   */
  async function run(args, options = {}) {
    const executablePath = await executable(options.signal)
    return spawnCommand(executablePath, args, options, `git ${args[0] ?? ''}`.trim())
  }

  /**
   * Run something that is not git, with the same guarantees `run` gives git.
   *
   * The user's Summary script is the one caller: it is a shell, not a git
   * subcommand, so `run` — which always prepends the git executable — cannot
   * launch it. Everything else about the contract is shared on purpose: the same
   * timeout, the same abort handling, the same bounded output, the same
   * environment, and the same "a non-zero exit is data, not a throw" rule.
   *
   * @param {readonly string[]} argv the executable and its arguments, in full
   * @param {object} [options] same as `run`
   * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, truncated: boolean }>}
   */
  async function runAny(argv, options = {}) {
    return spawnCommand(argv[0], argv.slice(1), options, String(argv[0] ?? ''))
  }

  /**
   * Spawn one child and collect it. Every launch in this module goes through
   * here, so there is exactly one place where the timeout, the abort ladder and
   * the output ceiling are decided.
   */
  async function spawnCommand(executablePath, args, options, label) {
    const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 30000
    // A zero/negative timeout means "no deadline of our own": still pass the
    // caller's signal so an aborted request does not leave a child running.
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    const signal =
      timeout === undefined
        ? options.signal
        : options.signal === undefined
          ? timeout
          : AbortSignal.any([options.signal, timeout])

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: [executablePath, ...args],
        cwd: options.cwd,
        stdio: {
          stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin },
          stdout: { maxBytes: options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES },
          stderr: { maxBytes: STDERR_TAIL_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        ...(signal === undefined ? {} : { signal }),
        env: { ...GIT_ENV, ...(options.env ?? {}) },
      })
    } catch (error) {
      // `spawn` refuses a spec it cannot honour *synchronously*: a signal that is
      // already aborted, or an argv/cwd/env/grace it considers invalid. Neither is
      // a verdict about the work, and letting the throw escape would reach the
      // route layer unclassified -- a generic internal error for a request that
      // was simply abandoned. Report it the way the asynchronous abort below does.
      throw new GitFailure(label, {
        exitCode: null,
        stdout: '',
        stderr: abortReason(signal, timeout, timeoutMs) ?? String(error?.message ?? error),
      })
    }

    const outcome = await handle.done

    if (signal !== undefined && signal.aborted) {
      throw new GitFailure(label, { exitCode: null, stdout: '', stderr: abortReason(signal, timeout, timeoutMs) })
    }

    const out = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const err = handle.collected.stderr?.readFrom(0) ?? { text: '', lossy: false }
    return { exitCode: outcome.exitCode, stdout: out.text, stderr: err.text, truncated: out.lossy === true }
  }

  /**
   * The repository root containing `cwd`, or `undefined` when there is none.
   *
   * The "not a repository" case is identified the way the shipped
   * `workspace-changes` plugin identifies it — exit 128 plus that exact stderr
   * — so a genuinely broken repository still surfaces as an error instead of
   * being reported as "no repository here".
   *
   * @param {string} cwd absolute directory to probe
   * @param {AbortSignal} [signal]
   * @returns {Promise<string | undefined>}
   */
  async function repoRootOf(cwd, signal) {
    const result = await run(['rev-parse', '--show-toplevel'], { cwd, signal })
    if (result.exitCode === NOT_A_REPOSITORY_EXIT && NOT_A_REPOSITORY.test(result.stderr)) return undefined
    if (result.exitCode !== 0) throw new GitFailure('git rev-parse --show-toplevel', result)
    const first = result.stdout.split('\n')[0]
    const root = typeof first === 'string' ? first.trim() : ''
    return root === '' ? undefined : root
  }

  /**
   * `true` when `candidate` is the root of a real working tree.
   *
   * Used to validate a user-chosen directory before it is persisted, so a bad
   * pick fails here with a message instead of poisoning the binding file.
   *
   * @param {string} candidate absolute path
   * @param {AbortSignal} [signal]
   */
  async function isRepoRoot(candidate, signal) {
    const result = await run(['rev-parse', '--show-toplevel', '--is-inside-work-tree'], { cwd: candidate, signal })
    if (result.exitCode !== 0) return undefined
    const [toplevel, inside] = result.stdout.split('\n').map((line) => line.trim())
    if (inside !== 'true' || typeof toplevel !== 'string' || toplevel === '') return undefined
    return toplevel
  }

  return { executable, run, runAny, repoRootOf, isRepoRoot }
}
