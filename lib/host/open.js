/**
 * Opening a working-tree file in a program the user picked.
 *
 * Why this lives on the host: the file is on the host's disk, and the program has
 * to run where the file is. A browser tab cannot start `notepad.exe`, and on a
 * remote client (Tailscale, a second machine) it should not even try — "open this
 * file" means "on the machine that holds the repository", which is exactly what
 * this half is.
 *
 * What it is not: a general "run this command" endpoint. The repository root is
 * resolved by the host, the path is confined to it (`absoluteIn`, the same check
 * every other file action makes), the program has to be one the host itself
 * listed, and the arguments are fixed by that listing — a client cannot name an
 * executable, only choose from a menu.
 *
 * @module dsh-lite-git/host/open
 */

import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ERROR_CODES } from '../shared.js'
import { RepoError, absoluteIn } from './repo.js'

/** Placeholder an opener's arguments use for the absolute path of the file. */
export const PATH_TOKEN = '{path}'

/** Placeholder for the directory holding it. */
export const DIR_TOKEN = '{dir}'

/** Milliseconds a child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2000

/**
 * Ceiling on what an opener may write back.
 *
 * Nothing reads it: a program that prints to stdout has nothing to say to the
 * panel, and the point of a ceiling is that a chatty child cannot fill memory
 * while it lives. `0` bytes would be enough; a small tail is cheaper to debug.
 */
const OPENER_OUTPUT_BYTES = 4096

/** The id of the "whatever this system opens it with" entry, on every platform. */
export const DEFAULT_OPENER_ID = 'default'

/**
 * What each platform can open a file with, before the user's own additions.
 *
 * Ids, not labels: the three built-ins are the same three ideas everywhere, and
 * the panel already has both dictionaries — so the copy lives in the client and
 * the host only says *which* one. A user-configured entry is the one case the
 * host has to name itself, because only the user knows what it is called.
 *
 * `notepad` exists instead of a generic "text editor" because on Windows that is
 * the program that is actually there; macOS's TextEdit and Linux's editor are the
 * same idea under their own names. Nothing here is resolved through `PATH` ahead
 * of time: the executables below ship with the OS, and a custom one that does not
 * exist fails loudly at `open` (E_NO_OPENER) rather than vanishing from a menu.
 *
 * @param {string} platform `process.platform`
 * @returns {Array<{ id: string, command: string, args: string[] }>}
 */
export function builtInOpeners(platform) {
  if (platform === 'win32') {
    return [
      { id: DEFAULT_OPENER_ID, command: 'explorer.exe', args: [PATH_TOKEN] },
      { id: 'notepad', command: 'notepad.exe', args: [PATH_TOKEN] },
      // `/select,<path>` has to be one argument, comma and all — that is the
      // whole syntax, and splitting it is how "show in folder" stops working.
      { id: 'reveal', command: 'explorer.exe', args: [`/select,${PATH_TOKEN}`] },
    ]
  }
  if (platform === 'darwin') {
    return [
      { id: DEFAULT_OPENER_ID, command: 'open', args: [PATH_TOKEN] },
      { id: 'editor', command: 'open', args: ['-a', 'TextEdit', PATH_TOKEN] },
      { id: 'reveal', command: 'open', args: ['-R', PATH_TOKEN] },
    ]
  }
  return [
    { id: DEFAULT_OPENER_ID, command: 'xdg-open', args: [PATH_TOKEN] },
    { id: 'reveal', command: 'xdg-open', args: [DIR_TOKEN] },
  ]
}

/**
 * The user's own entries in `Config.openWith`, in the same shape as the built-ins.
 *
 * An empty label or command is dropped rather than thrown on: a half-typed row in
 * the settings page must not park the whole plugin (that is what a throw during
 * `apply` does). A duplicate id cannot happen, because the id is positional.
 *
 * @param {{ openWith?: Array<{ label?: string, command?: string, args?: string[] }> }} config
 */
export function customOpeners(config) {
  const rows = Array.isArray(config?.openWith) ? config.openWith : []
  const openers = []
  rows.forEach((row, index) => {
    const label = typeof row?.label === 'string' ? row.label.trim() : ''
    const command = typeof row?.command === 'string' ? row.command.trim() : ''
    if (label === '' || command === '') return
    const args = Array.isArray(row?.args) ? row.args.filter((arg) => typeof arg === 'string') : []
    openers.push({ id: `custom:${index}`, label, command, args })
  })
  return openers
}

/**
 * Fill an opener's arguments in for one file.
 *
 * A template with no placeholder gets the path appended, because that is what
 * every program that takes a file wants and it is the obvious reading of
 * `{ command: "notepad.exe" }` with no arguments written. Everything after that
 * is literal: an argument is never re-split, so a path with a space in it stays
 * one argument all the way to the child.
 *
 * @param {string[]} args
 * @param {string} target absolute path
 * @returns {string[]}
 */
export function expandArgs(args, target) {
  const dir = dirname(target)
  const usesToken = args.some((arg) => arg.includes(PATH_TOKEN) || arg.includes(DIR_TOKEN))
  const expanded = args.map((arg) => arg.split(PATH_TOKEN).join(target).split(DIR_TOKEN).join(dir))
  return usesToken ? expanded : [...expanded, target]
}

/**
 * Build the opener for one plugin instance.
 *
 * @param {object} ctx host context (must have `subprocess` injected)
 * @param {object} config resolved plugin config
 * @param {string} [platform] `process.platform`, injectable for the tests
 */
export function createOpener(ctx, config, platform = process.platform) {
  const openers = [...builtInOpeners(platform), ...customOpeners(config)]

  /** The opener an id names, or a refusal. */
  function pick(id) {
    const wanted = typeof id === 'string' && id !== '' ? id : DEFAULT_OPENER_ID
    const found = openers.find((opener) => opener.id === wanted)
    if (found !== undefined) return found
    throw new RepoError(ERROR_CODES.BAD_REQUEST, `未知的打开方式：${wanted}`)
  }

  /**
   * What the panel may offer.
   *
   * No labels for the built-ins — the client translates those — and a label for
   * everything else, because a custom entry's name is the user's own text.
   */
  function list() {
    return {
      openers: openers.map((opener) => (opener.label === undefined ? { id: opener.id } : { id: opener.id, label: opener.label })),
    }
  }

  /** The entry to preselect: the one used last, if it is still offered. */
  function remember(prefs) {
    const wanted = typeof prefs?.openWith === 'string' ? prefs.openWith : ''
    return openers.some((opener) => opener.id === wanted) ? wanted : DEFAULT_OPENER_ID
  }

  /**
   * Open one file, and answer as soon as the child is started.
   *
   * Never waits for the program to exit: an editor is open for as long as the
   * user keeps it open, and a request that waited would sit on it until the
   * command timeout killed the very thing it launched. A command that cannot be
   * started at all throws out of `spawn` synchronously, which is the only
   * failure this can honestly report.
   */
  async function open({ repoRoot, path, openerId }) {
    const target = absoluteIn(repoRoot, path)
    const opener = pick(openerId)

    let stats
    try {
      stats = await stat(target)
    } catch {
      throw new RepoError(ERROR_CODES.NO_FILE, `工作区里已经没有这个文件了：${path}`)
    }
    if (stats.isFile() !== true) throw new RepoError(ERROR_CODES.NO_FILE, `这不是一个文件：${path}`)

    // Resolve the program before starting it, so a typo in `openWith` answers
    // "找不到这个程序" instead of a child that fails silently a moment later.
    // `spawn` reports a missing executable asynchronously, and this request has
    // already returned by then — the one thing it could honestly report would be
    // lost. Resolution is also what keeps a bare name from depending on whatever
    // PATH the harness happened to scrub.
    let executable
    try {
      executable = await ctx.subprocess.resolveExecutable(opener.command)
    } catch (error) {
      throw new RepoError(
        ERROR_CODES.NO_OPENER,
        `找不到这个程序（${opener.command}）：${String(error?.message ?? error)}`,
      )
    }

    const argv = [executable, ...expandArgs(opener.args, target)]
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        // The repository as the working directory, so an editor that starts in
        // its own cwd has the project side by side with the file it opened.
        cwd: repoRoot,
        stdio: { stdin: 'ignore', stdout: { maxBytes: OPENER_OUTPUT_BYTES }, stderr: { maxBytes: OPENER_OUTPUT_BYTES } },
        graceMs: TERMINATE_GRACE_MS,
      })
      // Fire and forget, but never leave a rejection unhandled: a program that
      // dies on start is not something this request is still waiting on.
      void Promise.resolve(handle.done).catch(() => {})
    } catch (error) {
      throw new RepoError(
        ERROR_CODES.NO_OPENER,
        `启动不了这个程序（${opener.command}）：${String(error?.message ?? error)}`,
      )
    }

    return { id: opener.id, path }
  }

  return { list, open, remember, ids: () => openers.map((opener) => opener.id) }
}
