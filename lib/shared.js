/**
 * dsh-gitbar-lite — wire contract, shared by the two halves.
 *
 * The browser half is a hand-written classic-script bundle and therefore cannot
 * `import` this module; it repeats these literals verbatim. `test/check.mjs`
 * asserts the repetition rather than trusting it — a drifted route or action
 * name fails silently at runtime (the client would `fetch` a path nobody
 * serves), which is exactly the failure this file exists to prevent.
 *
 * @module dsh-gitbar-lite/shared
 */

/** Package name; also the client module-loader id and the settings namespace. */
export const PLUGIN_ID = 'dsh-gitbar-lite'

/** The single exact Fetch route both halves speak over. */
export const RPC_ROUTE = '/api/dsh-gitbar-lite/rpc'

/** Every RPC action. The client sends `{ action, ...payload }`. */
export const ACTIONS = {
  /** Repository identity + working-tree status + branch/ahead-behind. */
  STATUS: 'status',
  /** Persist (or clear) this workspace's bound repository. */
  BIND: 'bind',
  /** Candidate repositories under the workspace, for the picker. */
  REPOS: 'repos',
  /** Stage or unstage the given paths, for real (`git add` / `git restore --staged`). */
  STAGE: 'stage',
  /** Commit what is staged. */
  COMMIT: 'commit',
  /** Commit what is staged, then push. */
  COMMIT_PUSH: 'commitAndPush',
  /** Push the current branch. */
  PUSH: 'push',
  /** Fetch from the upstream's remote. */
  FETCH: 'fetch',
  /** Discard changes: archive the diff, then restore. `paths: null` means all. */
  DISCARD: 'discard',
  /** One file's unified diff against HEAD, for the preview tab. */
  FILE_DIFF: 'fileDiff',
  /** Archived trash entries for the bound repository. */
  TRASH_LIST: 'trashList',
  /** One archived entry's diff text. */
  TRASH_DIFF: 'trashDiff',
  /** Drop one archived entry (and its diff on disk). */
  TRASH_DELETE: 'trashDelete',
  /** Drop every archived entry. */
  TRASH_CLEAR: 'trashClear',
  /**
   * Put one archived entry's changes back into the working tree.
   *
   * Refused with `E_TRASH_NOT_RESTORABLE` when the files it touched have moved on
   * since the discard, because writing back then would silently destroy work
   * that happened after the archive was taken.
   */
  TRASH_RESTORE: 'trashRestore',
  /**
   * Run the user's summary script and return what it printed.
   *
   * The script is the user's own text from the config, run with the repository
   * root as its working directory. The panel turns its output into a Summary
   * (and a Description), which is why this returns the output rather than
   * writing it anywhere itself.
   */
  RUN_SCRIPT: 'runScript',
  /**
   * Store this repository's Summary script, or clear it with an empty string.
   *
   * Separate from `PREFS` because the script belongs to a repository and a
   * preference belongs to the user: one shared value would run a Vue project's
   * script in a Rust one.
   */
  SAVE_SCRIPT: 'saveScript',
  /** Read or write the small persisted UI preferences. */
  PREFS: 'prefs',
}

/**
 * Machine-readable failure codes. The client shows `message` and branches on
 * `code` only where the recovery differs (a conflict, a rejected push, a
 * missing credential).
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'E_BAD_REQUEST',
  UNKNOWN_ACTION: 'E_UNKNOWN_ACTION',
  NO_WORKSPACE: 'E_NO_WORKSPACE',
  NO_REPO: 'E_NO_REPO',
  NO_GIT: 'E_NO_GIT',
  EMPTY_SUMMARY: 'E_EMPTY_SUMMARY',
  NOTHING_STAGED: 'E_NOTHING_STAGED',
  CONFLICT: 'E_CONFLICT',
  GIT_FAILED: 'E_GIT_FAILED',
  NO_REMOTE: 'E_NO_REMOTE',
  NO_UPSTREAM: 'E_NO_UPSTREAM',
  AUTH: 'E_AUTH',
  PUSH_REJECTED: 'E_PUSH_REJECTED',
  TRASH_NOT_FOUND: 'E_TRASH_NOT_FOUND',
  /**
   * The archive is real but the working tree has moved on since it was taken, so
   * putting it back would overwrite something newer.
   */
  TRASH_NOT_RESTORABLE: 'E_TRASH_NOT_RESTORABLE',
  INTERNAL: 'E_INTERNAL',
}

/**
 * Which label the single context button wears. The client maps these to copy;
 * the host decides by looking at the branch, the way GitHub Desktop does.
 */
export const PRIMARY_ACTIONS = {
  /** Local commits exist that the upstream does not have. */
  PUSH: 'push',
  /** The branch has no upstream yet, so the first push has to set one. */
  PUBLISH: 'publish',
  /** Nothing to push: the button fetches. */
  FETCH: 'fetch',
}

/**
 * Per-file status buckets. `untracked` and `conflicted` are the two cases where
 * a plain `git restore` is not the right verb.
 */
export const FILE_STATUS = {
  MODIFIED: 'modified',
  ADDED: 'added',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  UNTRACKED: 'untracked',
  CONFLICTED: 'conflicted',
}

/** Trash entry origin: one path, or a whole working tree. */
export const DISCARD_SCOPE = {
  FILE: 'file',
  ALL: 'all',
}

/** State-file names inside the plugin's own directory under DSH_HOME. */
export const STATE_FILES = {
  BINDINGS: 'bindings.json',
  PREFS: 'prefs.json',
  SCRIPTS: 'scripts.json',
  TRASH_INDEX: 'trash/index.json',
}

/** Directory the plugin owns under DSH_HOME. */
export const STATE_DIR_NAME = 'dsh-gitbar-lite'

/**
 * What the script box starts with for a repository that has never had one.
 *
 * A starting point rather than a feature: it is the one thing almost every
 * project has (a changelog whose top `## heading` is the version just released),
 * so the box opens with something that usually works instead of an empty box and
 * a hint. It reads the file case-insensitively because `changelog.md` and
 * `CHANGELOG.md` are both common and Windows would hide the difference while a
 * Linux checkout would not; `tr -d '\r'` strips a CRLF ending so the Summary does
 * not carry an invisible character.
 */
export const DEFAULT_SUMMARY_SCRIPT =
  "f=$(ls changelog.md CHANGELOG.md Changelog.md 2>/dev/null | head -n 1)\n" +
  '[ -n "$f" ] && grep -m1 \'^## \' "$f" | sed \'s/^## //\' | tr -d \'\\r\'\n'

/** Environment for every git child: no prompts, no locks, stable locale. */
export const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
}
