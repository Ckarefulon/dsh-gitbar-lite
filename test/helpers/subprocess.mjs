/**
 * A stand-in for `ctx.subprocess`.
 *
 * Why a double at all: the real service lives inside DSH's own bundle and is not
 * importable from a plugin repository, so `npm test` cannot construct it. Why
 * this one is written the tedious way: a double that does not answer the way the
 * real thing answers turns a passing suite into a lie. So every shape here is
 * copied from the shipped contract, and the call sites in `lib/host/git.js` only
 * use these members:
 *
 *   resolveExecutable(command, env?, signal?) -> Promise<string>
 *   spawn(spec) -> {
 *     collected: { stdout?: { readFrom(byteOffset): { text, nextOffset, lossy } }, stderr?: … },
 *     stdin, stdout, stderr, control,
 *     done: Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>,
 *     terminate(), waitForExit(signal?),
 *   }
 *
 * with the spec:
 *
 *   { argv: string[], cwd: string, stdio: { stdin, stdout, stderr }, graceMs, signal?, env? }
 *   stdio.stdin  : 'ignore' | 'pipe' | { data: string }
 *   stdio.stdout : 'pipe' | 'inherit' | { maxBytes: number }
 *
 * The one deliberate difference is that this double is *not* contained by a Job
 * object and does *not* scrub the environment; both belong to the real service.
 * `test/live.mjs` exists to close that gap on a machine that has DSH installed.
 *
 * @module dsh-lite-git/test/helpers/subprocess
 */

import { spawn as spawnChild } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** Executable suffixes to try for a bare command name on Windows. */
const WINDOWS_SUFFIXES = ['', '.exe', '.cmd', '.bat', '.com']

/** First existing file among `candidates`, or `undefined`. */
function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

/**
 * Build a subprocess double backed by `node:child_process`.
 *
 * @param {{ capture?: ((entry: { argv: string[], cwd?: string, env?: object }) => void) }} [options]
 *   `capture` sees every spawn, which is how the tests assert what git was
 *   actually asked to do rather than only what it answered.
 */
export function createFakeSubprocess(options = {}) {
  return {
    /**
     * Resolve an executable the way the harness documents it: an absolute path
     * is checked for existence, a bare name walks PATH, and a relative path with
     * a separator is refused outright.
     */
    async resolveExecutable(command) {
      if (typeof command !== 'string' || command === '') throw new Error('resolveExecutable: empty command')
      const hasSeparator = command.includes('/') || command.includes('\\')
      if (isAbsolute(command) || hasSeparator) {
        if (!isAbsolute(command)) throw new Error(`resolveExecutable: relative path with a separator is not allowed: ${command}`)
        const found = firstExecutable([command])
        if (found === undefined) throw new Error(`resolveExecutable: not found: ${command}`)
        return found
      }
      const path = process.env.PATH ?? ''
      const suffixes = process.platform === 'win32' ? WINDOWS_SUFFIXES : ['']
      const candidates = []
      for (const directory of path.split(delimiter)) {
        if (directory === '') continue
        for (const suffix of suffixes) candidates.push(join(directory, `${command}${suffix}`))
      }
      const found = firstExecutable(candidates)
      if (found === undefined) throw new Error(`resolveExecutable: not found on PATH: ${command}`)
      return found
    },

    spawn(spec) {
      const { argv, cwd, stdio, signal, env } = spec
      options.capture?.({ argv: [...argv], cwd, env })

      // Copied from the shipped contract, which says `spawn` "throws
      // synchronously when pre-aborted or when argv, cwd, environment, or grace
      // is invalid before handle creation". The pre-abort case is the one this
      // double used to get wrong — it started the child and killed it after —
      // which made `lib/host/git.js` look safe against a throw it never saw.
      // An invalid `cwd` already throws synchronously out of `node:child_process`.
      if (signal !== undefined && signal.aborted) {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        error.code = 'ABORT_ERR'
        throw error
      }

      const [executable, ...args] = argv
      const stdinMode = stdio?.stdin ?? 'ignore'
      const stdoutMode = stdio?.stdout ?? 'ignore'
      const stderrMode = stdio?.stderr ?? 'ignore'

      const child = spawnChild(executable, args, {
        cwd,
        env: env === undefined ? process.env : { ...process.env, ...env },
        windowsHide: true,
        stdio: [
          stdinMode === 'ignore' ? 'ignore' : 'pipe',
          stdoutMode === 'inherit' ? 'inherit' : 'pipe',
          stderrMode === 'inherit' ? 'inherit' : 'pipe',
        ],
      })

      /** Byte buffers plus the decoded view the real reader exposes. */
      const buffers = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, stdoutLossy: false, stderrLossy: false }

      const ceilingOf = (mode) =>
        mode !== null && typeof mode === 'object' && Number.isFinite(mode.maxBytes) ? mode.maxBytes : Number.POSITIVE_INFINITY

      const collect = (name, mode, chunk) => {
        const ceiling = ceilingOf(mode)
        const key = `${name}Bytes`
        if (buffers[key] + chunk.length > ceiling) {
          buffers[`${name}Lossy`] = true
          const room = Math.max(0, ceiling - buffers[key])
          if (room > 0) buffers[name].push(chunk.subarray(0, room))
          buffers[key] = ceiling
          return
        }
        buffers[name].push(chunk)
        buffers[key] += chunk.length
      }

      if (stdoutMode !== 'inherit' && child.stdout !== null) child.stdout.on('data', (chunk) => collect('stdout', stdoutMode, Buffer.from(chunk)))
      if (stderrMode !== 'inherit' && child.stderr !== null) child.stderr.on('data', (chunk) => collect('stderr', stderrMode, Buffer.from(chunk)))

      if (stdinMode !== 'ignore') {
        if (typeof stdinMode === 'object' && typeof stdinMode.data === 'string') {
          child.stdin?.end(stdinMode.data, 'utf8')
        } else {
          child.stdin?.end()
        }
      }

      const outcome = new Promise((resolvePromise) => {
        child.on('error', () => resolvePromise({ exitCode: null, signal: null }))
        child.on('close', (code, signalName) => resolvePromise({ exitCode: code, signal: signalName ?? null }))
      })

      const onAbort = () => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
      if (signal !== undefined) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      const reader = (name) => {
        const text = Buffer.concat(buffers[name]).toString('utf8')
        return {
          readFrom(offset) {
            const bytes = Buffer.concat(buffers[name])
            const from = Math.max(0, Math.min(Number(offset) || 0, bytes.length))
            return {
              text: bytes.subarray(from).toString('utf8'),
              nextOffset: bytes.length,
              lossy: buffers[`${name}Lossy`],
            }
          },
          /** Not part of the shipped contract; convenience for assertions. */
          get text() {
            return text
          },
        }
      }

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        control: undefined,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done: outcome,
        terminate: onAbort,
        async waitForExit() {
          await outcome
          return true
        },
      }
    },
  }
}
