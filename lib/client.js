/**
 * dsh-gitbar-lite — browser half.
 *
 * A hand-written lazy-CJS bundle: `window.__ModuleLoader__.load({ id, factory })`
 * with a `factory` that requires React and nothing else. No build step, no JSX,
 * no TypeScript. `@deepseek-ai/dsh-client-ui-primitives` is deliberately NOT
 * required: a throwing import blanks the whole slot entry, the seed module table
 * is a runtime contract this plugin would rather not widen, and the official
 * authoring checklist asks a client bundle to import no Harness Client package.
 * The handful of controls it would have supplied are drawn here against the same
 * design tokens, and the icons below are the host's own artwork copied
 * path-for-path so the column does not look foreign.
 *
 * Three tab types, all in the built-in right sidebar:
 *
 *   `gitbar`        the panel — changed files, tick-to-stage, Summary +
 *                   Description, Commit / Commit and Push, one context button
 *                   that is Push or Fetch depending on the branch, discard with
 *                   a confirmation box, and a repository picker for a workspace
 *                   that is not a repository.
 *   `gitbar-trash`  the plugin's own trash: the diffs discarded changes left
 *                   behind, with the base commit each one was taken against.
 *   `gitbar-diff`   one diff, in a single reused tab. A `dsh-resource://`
 *                   address (rather than a page kind) is what makes it a
 *                   singleton: the host reveals an already-open resource instead
 *                   of stacking a second copy, and a fresh `params` payload
 *                   re-navigates the tab that is already there.
 *
 * The panel and the trash tab are page kinds, opened by kind; only the panel
 * carries a guide card, because it is the one the user needs to find.
 *
 * @module dsh-gitbar-lite/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-gitbar-lite',
  factory: (require) => {
    // The loader passes `require` but no `module`, so every bundle declares its
    // own CommonJS-ish pair, exactly as the shipped bundles do.
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useMemo = React.useMemo
    const useRef = React.useRef

    /* ------------------------------------------------------------------ *
     * 1. Wire contract — mirror of lib/shared.js
     * ------------------------------------------------------------------ */

    /** Package name; also the module-loader id and the locale namespace. */
    const PLUGIN_ID = 'dsh-gitbar-lite'

    /** The one exact host route this half talks to. */
    const RPC_ROUTE = '/api/dsh-gitbar-lite/rpc'

    /** Every action name the host dispatches on (mirror of `ACTIONS`). */
    const ACTIONS = {
      STATUS: 'status',
      BIND: 'bind',
      REPOS: 'repos',
      STAGE: 'stage',
      COMMIT: 'commit',
      COMMIT_PUSH: 'commitAndPush',
      PUSH: 'push',
      FETCH: 'fetch',
      DISCARD: 'discard',
      FILE_DIFF: 'fileDiff',
      TRASH_LIST: 'trashList',
      TRASH_DIFF: 'trashDiff',
      TRASH_DELETE: 'trashDelete',
      TRASH_CLEAR: 'trashClear',
      PREFS: 'prefs',
    }

    /** Which label the single context button wears (mirror of `PRIMARY_ACTIONS`). */
    const PRIMARY = { PUSH: 'push', PUBLISH: 'publish', FETCH: 'fetch' }

    /** Diff-scope badge on a trash entry (mirror of `DISCARD_SCOPE`). */
    const SCOPE = { FILE: 'file', ALL: 'all' }

    /* ------------------------------------------------------------------ *
     * 2. Locale namespace, tab identities, and the dictionary
     * ------------------------------------------------------------------ */

    const NS = PLUGIN_ID

    /** The panel's tab type. `id` is also the slot key its body registers under. */
    const GIT_ID = `${PLUGIN_ID}/git`
    const GIT_KIND = 'gitbar'

    /** The trash tab type. */
    const TRASH_ID = `${PLUGIN_ID}/trash`
    const TRASH_KIND = 'gitbar-trash'

    /**
     * The diff tab type.
     *
     * `dsh-resource://` with a fixed address, not a page kind: re-opening the
     * same address reveals the tab that is already open (the host looks the
     * content id up across the whole layout before planning a new tab), and the
     * `params` payload re-navigates it. That is exactly "one diff tab, ever".
     */
    const DIFF_ID = `${PLUGIN_ID}/diff`
    const DIFF_KIND = 'gitbar-diff'
    const DIFF_ADDRESS = 'dsh-resource://dsh-gitbar-lite/diff/current'
    const DIFF_PATTERN = 'dsh-resource://dsh-gitbar-lite/diff/**'

    /** Where the guide card sits: after the shipped files(10) and terminal(20). */
    const GUIDE_ORDER = 30

    /**
     * Copy.
     *
     * This inline pair is the fallback for a composition without the locale
     * service (the browser harness is one), and it is also what gets registered
     * with the service when there is one. `test/check.mjs` compares both
     * dictionaries against `locale/zh.json` and `locale/en.json` so a key added
     * here cannot silently miss the shipped files.
     */
    const ZH = {
      'meta.title': 'Git 栏（轻量）',
      'meta.description': 'GitHub Desktop 风格的 Git 面板：变更文件、勾选提交、舍弃进回收站、Commit and Push、diff 预览。',

      'panel.title': 'Git',
      'guide.title': 'Git 更改',
      'guide.description': '查看改动、勾选要提交的文件、写 Summary 并提交或推送；双击文件看 diff。',

      'state.loading': '正在读取仓库…',
      'state.retry': '重试',
      'state.noRepo': '没有输出',

      'action.fetch': 'Fetch',
      'action.push': 'Push',
      'action.publish': 'Publish',
      'action.refresh': '刷新',
      'action.trash': '打开回收站',
      'action.rebind': '换绑仓库',
      'action.unbind': '解除绑定',
      'action.discard': '舍弃这个文件的更改',
      'action.discardAll': '全部舍弃',
      'action.cancel': '取消',
      'action.confirm': '舍弃',
      'action.delete': '删除这条记录',
      'action.clear': '清空回收站',
      'action.busy': '处理中…',

      'changes.title': '更改',
      'changes.empty': '工作区干净，没有要提交的更改。',
      'changes.summary': '{files} 个文件 · 已勾选 {staged}',

      'commit.summaryPlaceholder': 'Summary（必填）',
      'commit.descriptionPlaceholder': 'Description（可选）',
      'commit.expand': '展开 Description',
      'commit.collapse': '收起 Description',
      'commit.commit': 'Commit',
      'commit.commitAndPush': 'Commit and Push',
      'commit.needsSummary': '先写 Summary',
      'commit.needsStaged': '先勾选要提交的文件',

      'discard.one': '舍弃「{path}」的更改？',
      'discard.all': '舍弃全部 {files} 个文件的更改？',
      'discard.more': '还有 {n} 个…',
      'discard.hard': '彻底删除（不存入回收站）',
      'discard.keep': '这次的 diff 会存进插件的回收站，之后还能回看是改了什么。',
      'discard.hardHint': '这次不会留下任何记录，舍弃之后就找不回来了。',

      'bind.title': '这个工作区不是 Git 仓库',
      'bind.hint': '选择一个要绑定的仓库；绑定会记住，下次打开这个工作区还是它。',
      'bind.pathPlaceholder': '也可以直接填一个仓库目录的绝对路径',
      'bind.bind': '绑定',
      'bind.bindPath': '绑定这个路径',
      'bind.rescan': '重新扫描',
      'bind.scanning': '正在扫描…',
      'bind.noCandidates': '工作区里（3 层以内）没找到 Git 仓库，直接填路径吧。',
      'bind.truncated': '目录太多，扫描提前停止了。',
      'bind.current': '已绑定：{path}',
      'bind.notARepo': '这个目录不是 Git 仓库的根目录。',

      'trash.title': '回收站',
      'trash.empty': '回收站是空的。被舍弃的更改会连同当时的 diff 一起存在这里。',
      'trash.count': '{n} 条记录',
      'trash.scope.file': '单个文件',
      'trash.scope.all': '全部更改',
      'trash.base': '基于 {commit}',
      'trash.detail': '{files} 个文件 · +{added} −{deleted}',
      'trash.showAll': '显示全部仓库',
      'trash.onlyThis': '只看这个仓库',
      'trash.clearConfirm': '清空 {n} 条回收站记录？',
      'trash.clearHint': '这只是删掉归档的 diff，不会影响已经还原的工作区。',
      'trash.truncated': '（这条记录在归档时被截断了）',

      'diff.title': 'Diff',
      'diff.loading': '正在生成 diff…',
      'diff.empty': '没有可显示的 diff。',
      'diff.binary': '二进制文件，不显示内容。',
      'diff.truncated': 'diff 太长，已截断。',
      'diff.trashEntry': '回收站记录',

      'time.now': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
      'time.days': '{n} 天前',

      'err.E_BAD_REQUEST': '请求不合法。',
      'err.E_UNKNOWN_ACTION': '宿主不认识这个操作（插件版本可能不一致）。',
      'err.E_NO_WORKSPACE': '拿不到这个会话的工作区目录。',
      'err.E_NO_REPO': '还没有绑定 Git 仓库。',
      'err.E_NO_GIT': '本机找不到 git 可执行文件。装一个 Git，或在插件设置里指定 gitPath。',
      'err.E_EMPTY_SUMMARY': 'Summary 不能为空。',
      'err.E_NOTHING_STAGED': '没有勾选任何改动。',
      'err.E_CONFLICT': '仓库里有未解决的冲突，先解决它们。',
      'err.E_GIT_FAILED': 'git 命令失败了。',
      'err.E_NO_REMOTE': '这个仓库没有配置远端（remote）。',
      'err.E_NO_UPSTREAM': '这个分支还没有上游。',
      'err.E_AUTH': '推送认证失败：本机 git 没有可用凭据。先在终端里成功 push 一次。',
      'err.E_PUSH_REJECTED': '推送被拒绝：远端有你本地没有的提交，先 Fetch 再推。',
      'err.E_TRASH_NOT_FOUND': '这条回收站记录已经不在了。',
      'err.E_INTERNAL': '插件内部出错了。',
      'err.E_TRANSPORT': '和 DSH 宿主通信失败。',
      'err.E_BAD_RESPONSE': '宿主返回了无法解析的响应。',
      'err.E_UNKNOWN': '操作失败。',

      'toast.committed': '已提交 {commit}',
      'toast.pushed': '已推送',
      'toast.published': '已发布到这个远端',
      'toast.fetched': '已 Fetch',
      'toast.discarded': '已舍弃 {n} 个文件的更改',
      'toast.trashed': '已舍弃 {n} 个文件，diff 存进了回收站',
      'toast.bound': '已绑定这个仓库',
      'toast.unbound': '已解除绑定',
      'toast.trashCleared': '回收站已清空（{n} 条）',
      'toast.trashDeleted': '已删除那条记录',
      'toast.pushFailed': '已提交 {commit}，但推送失败',
    }

    const EN = {
      'meta.title': 'Git Bar (lite)',
      'meta.description': 'A GitHub Desktop-style Git panel: changed files, tick-to-stage, commit, commit and push, discard into a trash, and diff preview.',

      'panel.title': 'Git',
      'guide.title': 'Git changes',
      'guide.description': 'Review changes, tick what to commit, write a Summary and commit or push; double-click a file for its diff.',

      'state.loading': 'Reading the repository…',
      'state.retry': 'Retry',
      'state.noRepo': 'Nothing to show',

      'action.fetch': 'Fetch',
      'action.push': 'Push',
      'action.publish': 'Publish',
      'action.refresh': 'Refresh',
      'action.trash': 'Open the trash',
      'action.rebind': 'Change repository',
      'action.unbind': 'Unbind',
      'action.discard': 'Discard this file’s changes',
      'action.discardAll': 'Discard all',
      'action.cancel': 'Cancel',
      'action.confirm': 'Discard',
      'action.delete': 'Delete this entry',
      'action.clear': 'Empty the trash',
      'action.busy': 'Working…',

      'changes.title': 'Changes',
      'changes.empty': 'The working tree is clean — nothing to commit.',
      'changes.summary': '{files} files · {staged} ticked',

      'commit.summaryPlaceholder': 'Summary (required)',
      'commit.descriptionPlaceholder': 'Description (optional)',
      'commit.expand': 'Show the Description field',
      'commit.collapse': 'Hide the Description field',
      'commit.commit': 'Commit',
      'commit.commitAndPush': 'Commit and Push',
      'commit.needsSummary': 'Write a Summary first',
      'commit.needsStaged': 'Tick a file first',

      'discard.one': 'Discard the changes to “{path}”?',
      'discard.all': 'Discard the changes to all {files} files?',
      'discard.more': 'and {n} more…',
      'discard.hard': 'Delete for good (keep no copy)',
      'discard.keep': 'This diff is stored in the plugin’s trash, so you can still see what was discarded.',
      'discard.hardHint': 'Nothing is kept. Once discarded, this change cannot be recovered.',

      'bind.title': 'This workspace is not a Git repository',
      'bind.hint': 'Pick a repository to bind. The binding is remembered, so this workspace opens on it next time too.',
      'bind.pathPlaceholder': 'Or type the absolute path of a repository',
      'bind.bind': 'Bind',
      'bind.bindPath': 'Bind this path',
      'bind.rescan': 'Scan again',
      'bind.scanning': 'Scanning…',
      'bind.noCandidates': 'No Git repository found within three levels; type a path instead.',
      'bind.truncated': 'There were too many directories, so the scan stopped early.',
      'bind.current': 'Bound to {path}',
      'bind.notARepo': 'That directory is not the root of a Git repository.',

      'trash.title': 'Trash',
      'trash.empty': 'The trash is empty. Discarded changes are archived here with the diff they had at the time.',
      'trash.count': '{n} entries',
      'trash.scope.file': 'one file',
      'trash.scope.all': 'all changes',
      'trash.base': 'against {commit}',
      'trash.detail': '{files} files · +{added} −{deleted}',
      'trash.showAll': 'Show every repository',
      'trash.onlyThis': 'Only this repository',
      'trash.clearConfirm': 'Empty {n} trash entries?',
      'trash.clearHint': 'This only deletes the archived diffs; the restored working tree is untouched.',
      'trash.truncated': '(this entry was truncated when archived)',

      'diff.title': 'Diff',
      'diff.loading': 'Building the diff…',
      'diff.empty': 'There is no diff to show.',
      'diff.binary': 'Binary file — contents not shown.',
      'diff.truncated': 'The diff was too long and has been truncated.',
      'diff.trashEntry': 'Trash entry',

      'time.now': 'just now',
      'time.minutes': '{n} min ago',
      'time.hours': '{n} h ago',
      'time.days': '{n} d ago',

      'err.E_BAD_REQUEST': 'The request was not valid.',
      'err.E_UNKNOWN_ACTION': 'The host does not know that action (plugin versions may not match).',
      'err.E_NO_WORKSPACE': 'This session has no workspace directory to look in.',
      'err.E_NO_REPO': 'No Git repository is bound yet.',
      'err.E_NO_GIT': 'No git executable was found. Install Git, or set gitPath in the plugin settings.',
      'err.E_EMPTY_SUMMARY': 'The Summary cannot be empty.',
      'err.E_NOTHING_STAGED': 'Nothing is ticked.',
      'err.E_CONFLICT': 'The repository has unresolved conflicts; resolve them first.',
      'err.E_GIT_FAILED': 'A git command failed.',
      'err.E_NO_REMOTE': 'This repository has no remote configured.',
      'err.E_NO_UPSTREAM': 'This branch has no upstream yet.',
      'err.E_AUTH': 'Push authentication failed: the local git has no usable credential. Push once from a terminal first.',
      'err.E_PUSH_REJECTED': 'The push was rejected: the remote has commits you do not. Fetch, then push.',
      'err.E_TRASH_NOT_FOUND': 'That trash entry is gone.',
      'err.E_INTERNAL': 'The plugin hit an internal error.',
      'err.E_TRANSPORT': 'Could not reach the DSH host.',
      'err.E_BAD_RESPONSE': 'The host returned a response that could not be read.',
      'err.E_UNKNOWN': 'The operation failed.',

      'toast.committed': 'Committed {commit}',
      'toast.pushed': 'Pushed',
      'toast.published': 'Published this branch to the remote',
      'toast.fetched': 'Fetched',
      'toast.discarded': 'Discarded the changes to {n} files',
      'toast.trashed': 'Discarded {n} files; the diff went to the trash',
      'toast.bound': 'Bound to that repository',
      'toast.unbound': 'Binding cleared',
      'toast.trashCleared': 'Trash emptied ({n} entries)',
      'toast.trashDeleted': 'Entry deleted',
      'toast.pushFailed': 'Committed {commit}, but the push failed',
    }

    /** Interpolate `{name}` placeholders; the one syntax the locale service has. */
    function interpolate(template, params) {
      if (params === undefined) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }

    /** `true` when the browser is set to Chinese, for the no-locale-service case. */
    function prefersChinese() {
      const tag = typeof navigator === 'undefined' ? '' : String(navigator.language ?? '')
      return tag.toLowerCase().startsWith('zh')
    }

    /** The translate function used when the locale service is absent. */
    function fallbackTranslate() {
      const table = prefersChinese() ? ZH : EN
      return (key, params) => interpolate(Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key, params)
    }

    /** The host's own message for a code, or its text, or the raw code. */
    function errorText(t, code, fallback) {
      const key = `err.${code}`
      const localised = t(key)
      if (localised !== key) return localised
      return typeof fallback === 'string' && fallback !== '' ? fallback : code
    }

    /* ------------------------------------------------------------------ *
     * 3. Small pure helpers (covered by the unit tests)
     * ------------------------------------------------------------------ */

    const KIND_LETTER = {
      added: 'A',
      deleted: 'D',
      renamed: 'R',
      conflicted: '!',
      untracked: '?',
      modified: 'M',
    }

    /** The single character git itself would print in `status --short`. */
    function statusLetter(file) {
      if (file === null || typeof file !== 'object') return 'M'
      if (file.conflicted === true) return '!'
      if (file.untracked === true) return '?'
      return KIND_LETTER[file.kind] ?? 'M'
    }

    /** Split a repository path into the directory part and the file name. */
    function splitPath(path) {
      const text = String(path ?? '')
      const cut = text.lastIndexOf('/')
      return cut < 0 ? { dir: '', name: text } : { dir: text.slice(0, cut + 1), name: text.slice(cut + 1) }
    }

    /**
     * Classify the lines of a unified diff for rendering.
     *
     * Line numbers are tracked from each `@@` header so the gutter can show the
     * old and new line for every row, which is most of what makes a diff
     * readable. Everything before the first hunk is `meta` (the `diff --git`,
     * `index`, `---`/`+++` block), and the header of each file starts a `file`
     * group so a multi-file blob still reads as separate files.
     *
     * @returns {{ kind: string, text: string, oldLine?: number, newLine?: number, path?: string }[]}
     */
    function diffRows(text) {
      const source = typeof text === 'string' ? text : ''
      if (source === '') return []
      const lines = source.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

      const rows = []
      let oldLine = 0
      let newLine = 0
      let inHunk = false

      for (const line of lines) {
        if (line.startsWith('diff --git ')) {
          inHunk = false
          const body = line.slice('diff --git '.length)
          const halves = body.split(' ')
          const right = halves.length >= 2 ? halves[halves.length - 1] : body
          rows.push({ kind: 'file', text: line, path: right.startsWith('b/') ? right.slice(2) : right })
          continue
        }
        if (line.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          if (match !== null) {
            oldLine = Number(match[1])
            newLine = Number(match[2])
          }
          inHunk = true
          rows.push({ kind: 'hunk', text: line })
          continue
        }
        if (!inHunk) {
          rows.push({ kind: 'meta', text: line })
          continue
        }
        if (line.startsWith('+')) {
          rows.push({ kind: 'add', text: line.slice(1), newLine })
          newLine += 1
          continue
        }
        if (line.startsWith('-')) {
          rows.push({ kind: 'del', text: line.slice(1), oldLine })
          oldLine += 1
          continue
        }
        if (line.startsWith('\\')) {
          rows.push({ kind: 'note', text: line })
          continue
        }
        const content = line.startsWith(' ') ? line.slice(1) : line
        rows.push({ kind: 'ctx', text: content, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
      return rows
    }

    /**
     * A coarse relative time, localized by the copy table.
     *
     * @param {string} at ISO timestamp
     * @param {number} now epoch milliseconds
     * @param {(key: string, params?: object) => string} t
     */
    function formatRelative(at, now, t) {
      const when = Date.parse(String(at ?? ''))
      if (!Number.isFinite(when)) return ''
      const seconds = Math.max(0, Math.round((Number(now) - when) / 1000))
      if (seconds < 90) return t('time.now')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('time.minutes', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('time.hours', { n: hours })
      const days = Math.round(hours / 24)
      if (days <= 30) return t('time.days', { n: days })
      try {
        return new Date(when).toLocaleDateString()
      } catch {
        return String(at)
      }
    }

    /** How many of a status payload's files are ticked and commit-ready. */
    function stagedCount(state) {
      if (state === null || !Array.isArray(state.files)) return 0
      return state.files.filter((file) => file.staged === true && file.conflicted !== true).length
    }

    /** Whether a status payload has anything that cannot be committed as-is. */
    function hasConflict(state) {
      return state !== null && (state.counts?.conflicted ?? 0) > 0
    }

    /** The label the single context button wears, from the branch state. */
    function contextLabelKey(state) {
      if (state === null) return 'action.fetch'
      if (state.primary === PRIMARY.PUSH) return 'action.push'
      if (state.primary === PRIMARY.PUBLISH) return 'action.publish'
      return 'action.fetch'
    }

    /** The action the single context button performs. */
    function contextAction(state) {
      return state !== null && state.primary === PRIMARY.PUSH ? ACTIONS.PUSH : ACTIONS.FETCH
    }

    /**
     * Whether the commit buttons may be pressed, and why not when they may not.
     *
     * Extracted from the component so the rule can be asserted without a DOM: a
     * commit needs a Summary and at least one ticked, non-conflicted file, and
     * nothing else may be in flight. The host enforces the same rules again —
     * this is only what makes the button honest.
     *
     * @returns {{ canCommit: boolean, reasonKey: string | null }}
     */
    function commitReadiness(state, summary, busy) {
      const ready = stagedCount(state)
      if (hasConflict(state)) return { canCommit: false, reasonKey: 'err.E_CONFLICT' }
      if (String(summary ?? '').trim() === '') return { canCommit: false, reasonKey: 'commit.needsSummary' }
      if (ready === 0) return { canCommit: false, reasonKey: 'commit.needsStaged' }
      if (busy !== null && busy !== undefined) return { canCommit: false, reasonKey: null }
      return { canCommit: true, reasonKey: null }
    }

    /* ------------------------------------------------------------------ *
     * 4. Icons — the host's own artwork, copied path for path
     * ------------------------------------------------------------------ */

    /**
     * Build an icon on the host's 16×16 / currentColor grid.
     *
     * The host puts `stroke-width` on the `<svg>` and `stroke="currentColor"` on
     * each path; `getComputedStyle(svg).stroke` is `none`, so the path is where
     * the colour actually lives. `Regular` weight is 1.
     */
    function artwork(viewBox, paths, circles) {
      const Ink = ({ size = 16, className, strokeWidth }) =>
        h(
          'svg',
          {
            width: size,
            height: size,
            className,
            viewBox,
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
            strokeWidth: strokeWidth === undefined ? 1 : strokeWidth,
          },
          [
            ...paths.map((d, index) => h('path', { key: `p${index}`, d, stroke: 'currentColor' })),
            ...circles.map((circle, index) =>
              h('circle', {
                key: `c${index}`,
                cx: circle.cx,
                cy: circle.cy,
                r: circle.r,
                stroke: 'currentColor',
              }),
            ),
          ],
        )
      return Ink
    }

    /** `IconBranchOutlineRegular` — the panel's own mark. */
    const GitGlyph = artwork(
      '0 0 16 16',
      [
        'M1.01503 8.0001L5.6964 8.0001C6.41913 8.0001 6.78049 8.0001 7.12115 7.91951C7.4232 7.84804 7.71233 7.73014 7.97821 7.57C8.27809 7.38939 8.5364 7.13669 9.05303 6.63129L11.3281 4.40564',
        'M1.01221 7.9999L5.6964 7.9999C6.41913 7.9999 6.78049 7.9999 7.12115 8.08049C7.4232 8.15196 7.71233 8.26986 7.97821 8.43C8.27809 8.61061 8.5364 8.86331 9.05303 9.36871L11.3281 11.5944',
      ],
      [
        { cx: 12.4502, cy: 3.3079, r: 1.56962 },
        { cx: 12.4502, cy: 12.6921, r: 1.56962 },
      ],
    )

    /** `IconTrashOutlineRegular`. */
    const TrashGlyph = artwork(
      '0 0 16 16',
      [
        'M1.28149 3.88831H14.7187',
        'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
        'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
        'M6.44946 6.98926V11.1238',
        'M9.55054 6.98926V11.1238',
      ],
      [],
    )

    /** `IconArchiveOutlineRegular`. */
    const ArchiveGlyph = artwork(
      '0 0 16 16',
      [
        'M13.5 2.5H2.5C1.94772 2.5 1.5 2.94772 1.5 3.5V4.5C1.5 5.05228 1.94772 5.5 2.5 5.5H13.5C14.0523 5.5 14.5 5.05228 14.5 4.5V3.5C14.5 2.94772 14.0523 2.5 13.5 2.5Z',
        'M2.5 5.5V13.5C2.5 13.7652 2.60536 14.0196 2.79289 14.2071C2.98043 14.3946 3.23478 14.5 3.5 14.5H12.5C12.7652 14.5 13.0196 14.3946 13.2071 14.2071C13.3946 14.0196 13.5 13.7652 13.5 13.5V5.5',
        'M6.5 9.5H9.5',
      ],
      [],
    )

    /** `IconRefreshOutlineRegular`. */
    const RefreshGlyph = artwork(
      '0 0 16 16',
      [
        'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
        'M14.4999 1.5V5.1H10.8999',
      ],
      [],
    )

    /** `IconCloseOutlineRegular`. */
    const CloseGlyph = artwork('0 0 16 16', ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5'], [])

    /** `IconCheckOutlineRegular`. */
    const CheckGlyph = artwork(
      '0 0 16 16',
      ['M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4'],
      [],
    )

    /** `IconWarningTriangleOutlineRegular`. */
    const WarningGlyph = artwork(
      '0 0 16 16',
      ['M6.87 2.6a1.33 1.33 0 0 1 2.26 0l5.34 9.33A1.33 1.33 0 0 1 13.33 14H2.67a1.33 1.33 0 0 1-1.14-2.07Z', 'M8 6v3m0 2.33h.01'],
      [],
    )

    /** `IconChevronRightOutlineRegular`. */
    const ChevronRightGlyph = artwork(
      '0 0 16 16',
      ['M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4'],
      [],
    )

    /**
     * The guide card's mark.
     *
     * The card renders its icon at 22–26px. A 16px grid scaled up would thicken
     * the 1px stroke with it, so the stroke is divided by the size ratio to keep
     * the optical weight the same as a real 16px icon.
     */
    const GuideGlyph = ({ size = 26, className }) =>
      h(GitGlyph, { size, className, strokeWidth: 16 / size })

    /* ------------------------------------------------------------------ *
     * 5. Styles
     * ------------------------------------------------------------------ */

    const STYLE_ATTR = 'data-gitbar-style'

    /**
     * Tokens only, each with a light fallback, plus the panel's own dimensions.
     *
     * The root fills the host's `.tabBody` (`display:flex; height:100%;
     * min-height:0; overflow:hidden`) — the host gives a tab body no padding and
     * no scrollbar, so every scroll area here is declared explicitly.
     */
    const CSS = [
      '.gitbar-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;box-sizing:border-box;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary,#111827);background:var(--dsw-alias-bg-base,transparent)}',
      '.gitbar-head{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px 6px;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.18));min-width:0}',
      '.gitbar-ident{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1 1 auto}',
      '.gitbar-repo{font-weight:600;color:var(--dsw-alias-label-primary,#111827);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '.gitbar-branch{flex:none;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}',
      '.gitbar-ab{flex:none;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}',
      '.gitbar-tools{flex:none;display:flex;align-items:center;gap:2px}',
      '.gitbar-iconBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer;flex:none}',
      '.gitbar-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111827)}',
      '.gitbar-iconBtn:disabled{opacity:.4;cursor:default}',
      '.gitbar-iconBtn:focus-visible,.gitbar-btn:focus-visible,.gitbar-input:focus-visible,.gitbar-tick:focus-visible,.gitbar-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
      '.gitbar-iconBtn svg{width:15px;height:15px;display:block}',
      '.gitbar-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.gitbar-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.gitbar-btn:disabled{opacity:.45;cursor:default}',
      '.gitbar-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:var(--dsw-static-neutral-bluish-00,#fff);font-weight:500}',
      '.gitbar-btn-primary:hover:not(:disabled){filter:brightness(1.08)}',
      '.gitbar-btn-danger{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.gitbar-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.12))}',
      '.gitbar-banner{flex:none;display:flex;align-items:flex-start;gap:6px;margin:6px 10px 0;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);font-size:11.5px;word-break:break-word}',
      '.gitbar-banner-error{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.1));color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.gitbar-banner-warn{background:var(--dsw-alias-interactive-bg-hover,rgba(180,120,20,.12));color:var(--dsw-alias-state-warn-primary,#92400e)}',
      '.gitbar-banner-ok{background:var(--dsw-alias-interactive-bg-hover,rgba(22,163,74,.12));color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.gitbar-banner svg{width:14px;height:14px;flex:none;margin-top:1px;display:block}',
      '.gitbar-sub{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px 4px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;min-width:0}',
      '.gitbar-subTitle{flex:none;font-weight:500;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.gitbar-subStats{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.gitbar-list{flex:1 1 auto;min-height:40px;overflow:auto;padding:2px 6px 6px}',
      '.gitbar-row{display:flex;align-items:center;gap:4px;padding:3px 4px;border-radius:var(--dsw-radius-sm,6px);cursor:default;min-width:0}',
      '.gitbar-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.gitbar-tick{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;padding:0;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.45));border-radius:3px;background:transparent;color:var(--dsw-static-neutral-bluish-00,#fff);cursor:pointer}',
      '.gitbar-tick-on{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-tick-partial{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-tick svg{width:11px;height:11px;display:block}',
      '.gitbar-tick-partial span{display:block;width:7px;height:1.5px;background:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-letter{flex:none;width:13px;text-align:center;font-size:10.5px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.gitbar-letter-m{color:var(--dsw-alias-state-warn-primary,#b45309)}',
      '.gitbar-letter-a{color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.gitbar-letter-d{color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.gitbar-letter-r{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-letter-u{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-letter-c{color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.gitbar-path{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:0;overflow:hidden}',
      '.gitbar-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gitbar-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-stats{flex:none;display:flex;gap:3px;font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.gitbar-plus{color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.gitbar-minus{color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.gitbar-rowBtn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;opacity:0}',
      '.gitbar-row:hover .gitbar-rowBtn,.gitbar-rowBtn:focus-visible{opacity:1}',
      '.gitbar-rowBtn:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.14));color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      '.gitbar-rowBtn svg{width:14px;height:14px;display:block}',
      '.gitbar-empty{padding:14px 12px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11.5px;text-align:center}',
      '.gitbar-commit{flex:none;display:flex;flex-direction:column;gap:5px;padding:8px 10px 10px;border-top:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.18))}',
      '.gitbar-summaryRow{display:flex;align-items:center;gap:4px}',
      '.gitbar-input{box-sizing:border-box;flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px}',
      '.gitbar-input::placeholder{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      'textarea.gitbar-input{height:auto;min-height:56px;padding:6px 8px;resize:vertical;line-height:1.5}',
      '.gitbar-disclose{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer}',
      '.gitbar-disclose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111827)}',
      '.gitbar-disclose svg{width:13px;height:13px;display:block;transition:transform 120ms var(--ds-ease-in-out,ease)}',
      '.gitbar-disclose-open svg{transform:rotate(90deg)}',
      '.gitbar-actions{display:flex;gap:6px}',
      '.gitbar-actions .gitbar-btn{flex:1 1 0;min-width:0}',
      '.gitbar-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:12px;background:var(--dsw-alias-bg-mask-1,rgba(15,23,42,.45))}',
      '.gitbar-dialog{box-sizing:border-box;width:100%;max-width:360px;max-height:100%;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 12px 32px rgba(0,0,0,.28)}',
      '.gitbar-dialogTitle{font-size:13px;font-weight:600;word-break:break-word}',
      '.gitbar-dialogList{margin:0;padding:0 0 0 16px;max-height:140px;overflow:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.gitbar-dialogList li{word-break:break-all}',
      '.gitbar-dialogMore{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-checkRow{display:flex;align-items:flex-start;gap:7px;cursor:pointer;user-select:none}',
      '.gitbar-checkRow input{margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-checkText{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.gitbar-checkHint{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-dialogActions{display:flex;justify-content:flex-end;gap:6px}',
      '.gitbar-picker{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px 10px}',
      '.gitbar-pickerTitle{font-size:12.5px;font-weight:600}',
      '.gitbar-pickerHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-candidate{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:11.5px;text-align:left;cursor:pointer}',
      '.gitbar-candidate:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.gitbar-candidatePath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}',
      '.gitbar-tabTitle{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%}',
      '.gitbar-tabTitle svg{width:14px;height:14px;flex:none;display:block}',
      '.gitbar-tabTitleText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gitbar-diff{flex:1 1 auto;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;padding:0 0 12px}',
      '.gitbar-diffRow{display:flex;min-width:0}',
      '.gitbar-gutter{flex:none;display:flex;width:66px;color:var(--dsw-alias-label-tertiary,#6b7280);text-align:right;user-select:none}',
      '.gitbar-gutter span{flex:1 1 0;padding:0 5px;min-width:0}',
      '.gitbar-code{flex:1 1 auto;min-width:0;padding:0 8px 0 6px;white-space:pre-wrap;word-break:break-all}',
      '.gitbar-r-file{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111827);font-weight:600}',
      '.gitbar-r-hunk{background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.12));color:var(--dsw-alias-state-business-primary,#1d4ed8)}',
      '.gitbar-r-meta{color:var(--dsw-alias-label-tertiary,#6b7280)}',
      '.gitbar-r-add{background:var(--dsw-alias-interactive-bg-hover,rgba(22,163,74,.13));color:var(--dsw-alias-state-success-primary,#14532d)}',
      '.gitbar-r-del{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.13));color:var(--dsw-alias-state-error-primary,#7f1d1d)}',
      '.gitbar-r-note{color:var(--dsw-alias-label-tertiary,#6b7280);font-style:italic}',
      '.gitbar-r-ctx{color:var(--dsw-alias-label-secondary,#374151)}',
      '.gitbar-trashRow{display:flex;align-items:flex-start;gap:6px;width:100%;padding:7px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}',
      '.gitbar-trashRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}',
      '.gitbar-trashBody{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.gitbar-trashHead{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.gitbar-trashWhen{flex:none;color:var(--dsw-alias-label-primary,#111827);font-weight:500}',
      '.gitbar-badge{flex:none;padding:0 5px;border-radius:999px;font-size:10px;line-height:15px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.gitbar-trashMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gitbar-trashFiles{font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gitbar-toggle{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary,#6b7280);cursor:pointer;user-select:none;white-space:nowrap}',
      '.gitbar-toggle input{margin:0;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
      '.gitbar-spacer{flex:1 1 auto}',
      '.gitbar-loading{padding:18px 12px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11.5px;display:flex;align-items:center;gap:6px}',
      '.gitbar-spin{display:inline-block;width:13px;height:13px;flex:none;animation:gitbar-spin .9s linear infinite}',
      '.gitbar-spin svg{width:13px;height:13px;display:block}',
      '@keyframes gitbar-spin{to{transform:rotate(360deg)}}',
    ].join('\n')

    /** Inject the stylesheet once, through the usual `data-plugin` marker. */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[${STYLE_ATTR}]`) !== null) return
      const tag = document.createElement('style')
      tag.setAttribute(STYLE_ATTR, '')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ *
     * 6. RPC
     * ------------------------------------------------------------------ */

    /** An action failure carrying the host's code, so the UI can localize it. */
    function RpcError(code, message) {
      const error = new Error(message)
      error.name = 'RpcError'
      error.code = code
      return error
    }

    /**
     * One host call.
     *
     * The body is read before the status is judged: a failure still arrives as
     * JSON with `{ ok:false, error }`, and a non-2xx status must not be the only
     * signal.
     */
    async function rpc(action, payload, signal) {
      const body = Object.assign({ action }, payload === undefined ? {} : payload)
      let response
      try {
        response = await fetch(RPC_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (error !== null && error !== undefined && error.name === 'AbortError') throw error
        throw RpcError('E_TRANSPORT', String((error && error.message) || error))
      }

      let data = null
      try {
        data = await response.json()
      } catch {
        throw RpcError('E_BAD_RESPONSE', `HTTP ${response.status}`)
      }
      if (data === null || typeof data !== 'object') throw RpcError('E_BAD_RESPONSE', `HTTP ${response.status}`)
      if (data.ok !== true) {
        const failure = data.error
        throw RpcError(
          failure !== null && typeof failure?.code === 'string' ? failure.code : 'E_UNKNOWN',
          failure !== null && typeof failure?.message === 'string' ? failure.message : `HTTP ${response.status}`,
        )
      }
      return data
    }

    /* ------------------------------------------------------------------ *
     * 7. Shared pieces
     * ------------------------------------------------------------------ */

    /** A `<button>` with the panel's icon-button chrome. */
    function IconButton({ label, onClick, disabled, className, children, attrs }) {
      return h(
        'button',
        {
          type: 'button',
          className: `gitbar-iconBtn${className === undefined ? '' : ` ${className}`}`,
          title: label,
          'aria-label': label,
          disabled: disabled === true,
          onClick,
          ...(attrs ?? {}),
        },
        children,
      )
    }

    /** The loading indicator: the host's arc plus a plain rotation. */
    function LoadingGlyph() {
      // `IconLoadingOutlineRegular` — the arc the host itself spins.
      const Arc = artwork(
        '0 0 16 16',
        [
          'M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398',
        ],
        [],
      )
      return h('span', { className: 'gitbar-spin', 'aria-hidden': 'true' }, h(Arc, {}))
    }

    function Spinner({ label }) {
      return h('div', { className: 'gitbar-loading' }, [h(LoadingGlyph, { key: 's' }), h('span', { key: 't' }, label)])
    }

    /** A one-line notice above the list. */
    function Banner({ tone, text, onClose, closeLabel }) {
      const Glyph = tone === 'error' ? WarningGlyph : tone === 'warn' ? WarningGlyph : CheckGlyph
      return h('div', { className: `gitbar-banner gitbar-banner-${tone}`, role: 'status' }, [
        h(Glyph, { key: 'g' }),
        h('span', { key: 't', style: { flex: '1 1 auto', minWidth: 0 } }, text),
        onClose === undefined
          ? null
          : h(
              'button',
              {
                key: 'x',
                type: 'button',
                className: 'gitbar-iconBtn',
                style: { width: 18, height: 18 },
                title: closeLabel,
                'aria-label': closeLabel,
                onClick: onClose,
              },
              h(CloseGlyph, { size: 12 }),
            ),
      ])
    }

    /** The username-and-repo tail of a path, for a narrow column. */
    function shortPath(path) {
      const parts = String(path ?? '').split(/[\\/]/).filter((part) => part !== '')
      return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`
    }

    /* ------------------------------------------------------------------ *
     * 8. The panel
     * ------------------------------------------------------------------ */

    /** One changed file. */
    function ChangeRow({ file, t, onToggle, onDiscard, onOpen }) {
      const letter = statusLetter(file)
      const letterClass =
        letter === 'M' ? 'm' : letter === 'A' ? 'a' : letter === 'D' ? 'd' : letter === 'R' ? 'r' : letter === '?' ? 'u' : 'c'
      const parts = splitPath(file.path)
      const display = file.origPath === undefined ? file.path : `${file.origPath} → ${file.path}`

      return h(
        'div',
        {
          className: 'gitbar-row',
          'data-gitbar-row': file.path,
          'data-gitbar-staged': file.staged === true ? 'true' : 'false',
          title: display,
          onDoubleClick: () => onOpen(file.path),
        },
        [
          h(
            'button',
            {
              key: 'tick',
              type: 'button',
              className: `gitbar-tick${file.staged === true && !file.partial ? ' gitbar-tick-on' : file.partial === true ? ' gitbar-tick-partial' : ''}`,
              'data-gitbar-tick': file.path,
              'aria-checked': file.staged === true ? 'true' : 'false',
              role: 'checkbox',
              'aria-label': file.path,
              onClick: (event) => {
                event.stopPropagation()
                onToggle(file)
              },
            },
            file.staged === true && !file.partial ? h(CheckGlyph, { size: 11 }) : file.partial === true ? h('span', {}) : null,
          ),
          h('span', { key: 'letter', className: `gitbar-letter gitbar-letter-${letterClass}` }, letter),
          h('span', { key: 'path', className: 'gitbar-path' }, [
            h('span', { key: 'name', className: 'gitbar-name' }, parts.name),
            parts.dir === '' ? null : h('span', { key: 'dir', className: 'gitbar-dir' }, ` ${parts.dir}`),
          ]),
          h('span', { key: 'stats', className: 'gitbar-stats' }, [
            (file.added ?? 0) > 0 ? h('span', { key: 'p', className: 'gitbar-plus' }, `+${file.added}`) : null,
            (file.deleted ?? 0) > 0 ? h('span', { key: 'm', className: 'gitbar-minus' }, `−${file.deleted}`) : null,
          ]),
          h(
            'button',
            {
              key: 'discard',
              type: 'button',
              className: 'gitbar-rowBtn',
              'data-gitbar-discard': file.path,
              title: t('action.discard'),
              'aria-label': t('action.discard'),
              onClick: (event) => {
                event.stopPropagation()
                onDiscard(file.path)
              },
            },
            h(TrashGlyph, { size: 14 }),
          ),
        ],
      )
    }

    /** The discard confirmation, drawn inside the panel rather than portalled. */
    function DiscardDialog({ pending, t, onCancel, onHardDeleteChange, onConfirm }) {
      if (pending === null) return null
      const files = pending.files
      const shown = files.slice(0, 8)
      const title =
        pending.paths === null
          ? t('discard.all', { files: files.length })
          : t('discard.one', { path: pending.paths[0] })

      return h('div', { className: 'gitbar-overlay', 'data-gitbar-dialog': 'discard' }, [
        h('div', { className: 'gitbar-dialog', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { key: 'title', className: 'gitbar-dialogTitle' }, title),
          h(
            'ul',
            { key: 'list', className: 'gitbar-dialogList' },
            shown.map((file) => h('li', { key: file }, file)),
          ),
          files.length > shown.length
            ? h('div', { key: 'more', className: 'gitbar-dialogMore' }, t('discard.more', { n: files.length - shown.length }))
            : null,
          h('label', { key: 'hard', className: 'gitbar-checkRow' }, [
            h('input', {
              type: 'checkbox',
              checked: pending.hardDelete,
              'data-gitbar-hard': '',
              onChange: (event) => onHardDeleteChange(event.target.checked === true),
            }),
            h('span', { className: 'gitbar-checkText' }, [
              h('span', { key: 'l' }, t('discard.hard')),
              h('span', { key: 'h', className: 'gitbar-checkHint' }, pending.hardDelete ? t('discard.hardHint') : t('discard.keep')),
            ]),
          ]),
          h('div', { key: 'actions', className: 'gitbar-dialogActions' }, [
            h(
              'button',
              { key: 'cancel', type: 'button', className: 'gitbar-btn', onClick: onCancel },
              t('action.cancel'),
            ),
            h(
              'button',
              {
                key: 'go',
                type: 'button',
                className: 'gitbar-btn gitbar-btn-danger',
                'data-gitbar-confirm': '',
                onClick: onConfirm,
              },
              t('action.confirm'),
            ),
          ]),
        ]),
      ])
    }

    /** The repository picker for a workspace that is not a repository. */
    function RepositoryPicker({ candidates, truncated, scanning, pathInput, t, onPick, onPath, onPathChange, onRescan, onUnbind, bound }) {
      return h('div', { className: 'gitbar-picker', 'data-gitbar-picker': '' }, [
        h('div', { key: 'title', className: 'gitbar-pickerTitle' }, t('bind.title')),
        h('div', { key: 'hint', className: 'gitbar-pickerHint' }, t('bind.hint')),
        bound === null
          ? null
          : h('div', { key: 'bound', className: 'gitbar-pickerHint' }, [
              t('bind.current', { path: bound }),
              ' ',
              h(
                'button',
                { key: 'unbind', type: 'button', className: 'gitbar-btn', style: { marginLeft: 6 }, onClick: onUnbind },
                t('action.unbind'),
              ),
            ]),
        scanning ? h(Spinner, { key: 'scan', label: t('bind.scanning') }) : null,
        !scanning && candidates.length === 0
          ? h('div', { key: 'none', className: 'gitbar-pickerHint' }, t('bind.noCandidates'))
          : null,
        ...candidates.map((candidate) =>
          h(
            'button',
            {
              key: candidate.path,
              type: 'button',
              className: 'gitbar-candidate',
              'data-gitbar-candidate': candidate.path,
              onClick: () => onPick(candidate.path),
            },
            [
              h(GitGlyph, { key: 'g', size: 14 }),
              h('span', { key: 'p', className: 'gitbar-candidatePath', title: candidate.path }, candidate.path),
            ],
          ),
        ),
        truncated ? h('div', { key: 'trunc', className: 'gitbar-pickerHint' }, t('bind.truncated')) : null,
        h('div', { key: 'manual', className: 'gitbar-summaryRow' }, [
          h('input', {
            key: 'input',
            className: 'gitbar-input',
            placeholder: t('bind.pathPlaceholder'),
            value: pathInput,
            'data-gitbar-pathinput': '',
            onChange: (event) => onPathChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onPath()
            },
          }),
          h('button', { key: 'go', type: 'button', className: 'gitbar-btn', onClick: onPath }, t('bind.bindPath')),
        ]),
        h(
          'button',
          { key: 'rescan', type: 'button', className: 'gitbar-btn', onClick: onRescan, disabled: scanning },
          t('bind.rescan'),
        ),
      ])
    }

    /**
     * The Git panel body.
     *
     * Ticks are not local state: a file's tick *is* whether all of its change is
     * in the repository index, so ticking calls the host and adopts the status
     * that comes back. That is what keeps this panel and `git status` in a
     * terminal from ever disagreeing.
     */
    function GitBody(props) {
      const t = props.t ?? fallbackTranslate()
      const ctx = props.ctx
      // `useTabInfo` is a hook the host binds into this seat's props (the shell
      // declares `inject: { hooks: { tabInfo } }` on the slot itself), so it has
      // to be called unconditionally at the top of the body.
      const tab = props.useTabInfo().tab
      const sessionId = props.sessionId ?? tab.sessionId

      const [state, setState] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(null)
      const [summary, setSummary] = useState('')
      const [description, setDescription] = useState('')
      const [descriptionOpen, setDescriptionOpen] = useState(false)
      const [pending, setPending] = useState(null)
      const [pathInput, setPathInput] = useState('')
      const [scanning, setScanning] = useState(false)

      const alive = useRef(true)
      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      /** Fetch the whole panel state. Never throws. */
      const load = useCallback(
        async (options = {}) => {
          if (options.quiet !== true) setPhase((current) => (current === 'ready' ? current : 'loading'))
          try {
            const data = await rpc(ACTIONS.STATUS, { sessionId }, tab.signal)
            if (!alive.current) return
            setState(data)
            setError(null)
            setPhase('ready')
          } catch (failure) {
            if (!alive.current || failure?.name === 'AbortError') return
            setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
            setPhase('error')
          }
        },
        [sessionId, tab.signal],
      )

      // Load on mount, and again whenever this tab comes back to the front —
      // the panel can be looking at a working tree the agent just changed.
      const wasVisible = useRef(false)
      const loadedOnce = useRef(false)
      useEffect(() => {
        const visible = tab.visible !== false
        if (!loadedOnce.current || visible) {
          loadedOnce.current = true
          wasVisible.current = visible
          // Quiet when there is already something to show, so returning to the
          // tab does not flash the loading state over a list the user recognises.
          void load({ quiet: state !== null })
        }
      }, [tab.visible, sessionId, load])

      // The column's refresh shortcut, when it has one.
      useEffect(
        () => (typeof tab.actions?.bindCommands === 'function' ? tab.actions.bindCommands({ refresh: () => void load({ quiet: true }) }) : undefined),
        [tab.actions, load],
      )

      /** Say something briefly. */
      const flash = useCallback((tone, text) => {
        setNotice({ tone, text, at: Date.now() })
      }, [])

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => {
          if (alive.current) setNotice(null)
        }, 6000)
        return () => clearTimeout(timer)
      }, [notice])

      /** Run one mutating action, adopting the status it returns. */
      const run = useCallback(
        async (kind, action, payload, onDone) => {
          setBusy(kind)
          try {
            const data = await rpc(action, { sessionId, ...(payload ?? {}) }, tab.signal)
            if (!alive.current) return null
            setError(null)
            // Most actions answer with a fresh status; binding answers with only
            // the new repository, so anything that is not a status is followed by
            // a re-read rather than being mistaken for one.
            if (Array.isArray(data.files) && data.branch !== undefined) setState(data)
            else await load({ quiet: true })
            if (onDone !== undefined) onDone(data)
            return data
          } catch (failure) {
            if (!alive.current) return null
            if (failure?.name === 'AbortError') return null
            setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
            // Even a failed action can have changed the repository (a commit that
            // did land before its push was rejected), so re-read.
            void load({ quiet: true })
            return null
          } finally {
            if (alive.current) setBusy(null)
          }
        },
        [sessionId, load, tab.signal],
      )

      const toggle = useCallback(
        (file) => {
          void run('stage', ACTIONS.STAGE, { paths: [file.path], staged: file.staged !== true })
        },
        [run],
      )

      const openDiff = useCallback(
        (path) => {
          setNotice(null)
          ctx.sidebarRight.openResourceIn(sessionId, DIFF_ADDRESS, {
            params: { source: 'worktree', path, revision: Date.now() },
          })
        },
        [ctx, sessionId],
      )

      const askDiscard = useCallback(
        (paths) => {
          if (state === null) return
          const targets = paths === null ? state.files.map((file) => file.path) : paths
          setPending({
            paths: paths === null ? null : paths,
            files: targets,
            hardDelete: state.prefs?.trashHardDelete === true,
          })
        },
        [state],
      )

      const confirmDiscard = useCallback(() => {
        if (pending === null) return
        const target = pending
        setPending(null)
        void run(
          'discard',
          ACTIONS.DISCARD,
          { paths: target.paths, hardDelete: target.hardDelete },
          (data) => {
            const count = (data.discard?.restored?.length ?? 0) + (data.discard?.deleted?.length ?? 0)
            flash('ok', target.hardDelete ? t('toast.discarded', { n: count }) : t('toast.trashed', { n: count }))
          },
        )
      }, [pending, run, flash, t])

      const commit = useCallback(
        (andPush) => {
          const action = andPush ? ACTIONS.COMMIT_PUSH : ACTIONS.COMMIT
          void run('commit', action, { summary, description }, (data) => {
            setSummary('')
            setDescription('')
            setDescriptionOpen(false)
            const short = data.commit?.short ?? ''
            if (andPush && data.push?.ok === false) {
              flash('warn', `${t('toast.pushFailed', { commit: short })}：${errorText(t, data.push.error?.code, data.push.error?.message)}`)
              return
            }
            flash('ok', andPush ? `${t('toast.committed', { commit: short })} · ${t('toast.pushed')}` : t('toast.committed', { commit: short }))
          })
        },
        [run, summary, description, flash, t],
      )

      const runContext = useCallback(() => {
        const action = contextAction(state)
        void run('context', action, undefined, (data) => {
          if (action === ACTIONS.PUSH) {
            flash('ok', data.outcome?.published === true ? t('toast.published') : t('toast.pushed'))
          } else {
            flash('ok', t('toast.fetched'))
          }
        })
      }, [run, state, flash, t])

      const openTrash = useCallback(() => {
        ctx.sidebarRight.openTabIn(sessionId, TRASH_KIND)
      }, [ctx, sessionId])

      const bind = useCallback(
        (repoRoot) => {
          void run('bind', ACTIONS.BIND, { repoRoot }, () => {
            flash('ok', repoRoot === null ? t('toast.unbound') : t('toast.bound'))
          })
        },
        [run, flash, t],
      )

      const rescan = useCallback(async () => {
        setScanning(true)
        try {
          const data = await rpc(ACTIONS.REPOS, { sessionId }, tab.signal)
          if (alive.current) setState((current) => ({ ...(current ?? {}), ...data }))
        } catch (failure) {
          if (alive.current && failure?.name !== 'AbortError') {
            setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
          }
        } finally {
          if (alive.current) setScanning(false)
        }
      }, [sessionId, tab.signal])

      /* ---------------------------------------------------------------- render */

      if (state === null && phase !== 'error') {
        return h('div', { className: 'gitbar-root', 'data-gitbar': 'loading' }, h(Spinner, { label: t('state.loading') }))
      }

      if (state === null && phase === 'error') {
        return h('div', { className: 'gitbar-root', 'data-gitbar': 'error' }, [
          h(Banner, {
            key: 'b',
            tone: 'error',
            text: errorText(t, error?.code, error?.message),
          }),
          h(
            'div',
            { key: 'a', className: 'gitbar-picker' },
            h('button', { type: 'button', className: 'gitbar-btn', onClick: () => void load() }, t('state.retry')),
          ),
        ])
      }

      // Unbound: the workspace is not a repository, so ask which one it is.
      if (state.repoRoot === null || state.repoRoot === undefined) {
        return h('div', { className: 'gitbar-root', 'data-gitbar': 'picker' }, [
          error === null ? null : h(Banner, { key: 'err', tone: 'error', text: errorText(t, error.code, error.message) }),
          notice === null ? null : h(Banner, { key: 'notice', tone: notice.tone, text: notice.text }),
          h(RepositoryPicker, {
            key: 'picker',
            candidates: state.candidates ?? [],
            truncated: state.scanTruncated === true,
            scanning,
            pathInput,
            t,
            bound: null,
            onPick: (path) => bind(path),
            onPath: () => bind(pathInput),
            onPathChange: setPathInput,
            onRescan: () => void rescan(),
            onUnbind: () => bind(null),
          }),
        ])
      }

      const files = state.files ?? []
      const readiness = commitReadiness(state, summary, busy)
      const canCommit = readiness.canCommit
      const commitHint = readiness.reasonKey === null ? '' : t(readiness.reasonKey)

      return h('div', { className: 'gitbar-root', 'data-gitbar': 'panel', style: { position: 'relative' } }, [
        h('div', { key: 'head', className: 'gitbar-head' }, [
          h('div', { key: 'ident', className: 'gitbar-ident' }, [
            h('span', { key: 'repo', className: 'gitbar-repo', title: state.repoRoot }, state.repoName ?? state.repoRoot),
            h(
              'span',
              { key: 'branch', className: 'gitbar-branch', title: state.branch?.head ?? '' },
              state.branch?.detached === true ? `(${state.branch?.head ?? ''})` : state.branch?.head ?? '',
            ),
            state.branch !== undefined && (state.branch.ahead > 0 || state.branch.behind > 0)
              ? h('span', { key: 'ab', className: 'gitbar-ab' }, `↑${state.branch.ahead} ↓${state.branch.behind}`)
              : null,
          ]),
          h('div', { key: 'tools', className: 'gitbar-tools' }, [
            h(
              IconButton,
              {
                key: 'ctx',
                label: t(contextLabelKey(state)),
                disabled: busy !== null,
                onClick: runContext,
                className: 'gitbar-contextBtn',
                attrs: { 'data-gitbar-context': state.primary ?? 'fetch', style: { width: 'auto', padding: '0 8px', fontWeight: 500 } },
              },
              h('span', { style: { whiteSpace: 'nowrap' } }, t(contextLabelKey(state))),
            ),
            h(
              IconButton,
              { key: 'refresh', label: t('action.refresh'), disabled: busy !== null, onClick: () => void load({ quiet: true }) },
              h(RefreshGlyph, {}),
            ),
            h(IconButton, { key: 'trash', label: t('action.trash'), onClick: openTrash }, h(ArchiveGlyph, {})),
            h(
              IconButton,
              { key: 'rebind', label: t('action.rebind'), disabled: busy !== null, onClick: () => bind(null) },
              h(GitGlyph, {}),
            ),
          ]),
        ]),

        error === null ? null : h(Banner, { key: 'err', tone: 'error', text: errorText(t, error.code, error.message), onClose: () => setError(null), closeLabel: t('action.cancel') }),
        notice === null ? null : h(Banner, { key: 'notice', tone: notice.tone, text: notice.text }),

        h('div', { key: 'sub', className: 'gitbar-sub' }, [
          h('span', { key: 'title', className: 'gitbar-subTitle' }, t('changes.title')),
          h(
            'span',
            { key: 'stats', className: 'gitbar-subStats' },
            t('changes.summary', { files: files.length, staged: stagedCount(state) }),
          ),
          hasConflict(state)
            ? h('span', { key: 'warn', className: 'gitbar-ab', title: t('err.E_CONFLICT') }, '⚠')
            : null,
          h(
            'button',
            {
              key: 'all',
              type: 'button',
              className: 'gitbar-btn',
              'data-gitbar-discardall': '',
              disabled: files.length === 0 || busy !== null,
              onClick: () => askDiscard(null),
            },
            t('action.discardAll'),
          ),
        ]),

        h(
          'div',
          { key: 'list', className: 'gitbar-list', 'data-gitbar-list': '' },
          files.length === 0
            ? h('div', { className: 'gitbar-empty' }, t('changes.empty'))
            : files.map((file) =>
                h(ChangeRow, {
                  key: file.path,
                  file,
                  t,
                  onToggle: toggle,
                  onDiscard: (path) => askDiscard([path]),
                  onOpen: openDiff,
                }),
              ),
        ),

        h('div', { key: 'commit', className: 'gitbar-commit' }, [
          h('div', { key: 'summary', className: 'gitbar-summaryRow' }, [
            h('input', {
              key: 'input',
              className: 'gitbar-input',
              placeholder: t('commit.summaryPlaceholder'),
              value: summary,
              'data-gitbar-summary': '',
              disabled: busy !== null,
              onChange: (event) => setSummary(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) commit(false)
              },
            }),
            h(
              'button',
              {
                key: 'disclose',
                type: 'button',
                className: `gitbar-disclose${descriptionOpen ? ' gitbar-disclose-open' : ''}`,
                title: descriptionOpen ? t('commit.collapse') : t('commit.expand'),
                'aria-label': descriptionOpen ? t('commit.collapse') : t('commit.expand'),
                'aria-expanded': descriptionOpen ? 'true' : 'false',
                'data-gitbar-describe': '',
                onClick: () => setDescriptionOpen((open) => !open),
              },
              h(ChevronRightGlyph, { size: 13 }),
            ),
          ]),
          descriptionOpen
            ? h('textarea', {
                key: 'description',
                className: 'gitbar-input',
                placeholder: t('commit.descriptionPlaceholder'),
                value: description,
                'data-gitbar-description': '',
                disabled: busy !== null,
                onChange: (event) => setDescription(event.target.value),
              })
            : null,
          h('div', { key: 'actions', className: 'gitbar-actions' }, [
            h(
              'button',
              {
                key: 'commit',
                type: 'button',
                className: 'gitbar-btn gitbar-btn-primary',
                title: canCommit ? '' : commitHint,
                disabled: !canCommit,
                'data-gitbar-commit': '',
                onClick: () => commit(false),
              },
              t('commit.commit'),
            ),
            h(
              'button',
              {
                key: 'push',
                type: 'button',
                className: 'gitbar-btn',
                title: canCommit ? '' : commitHint,
                disabled: !canCommit,
                'data-gitbar-commitpush': '',
                onClick: () => commit(true),
              },
              t('commit.commitAndPush'),
            ),
          ]),
        ]),

        h(DiscardDialog, {
          key: 'dialog',
          pending,
          t,
          onCancel: () => setPending(null),
          onHardDeleteChange: (hardDelete) => setPending((current) => (current === null ? null : { ...current, hardDelete })),
          onConfirm: confirmDiscard,
        }),
      ])
    }

    /* ------------------------------------------------------------------ *
     * 9. The trash tab
     * ------------------------------------------------------------------ */

    function TrashBody(props) {
      const t = props.t ?? fallbackTranslate()
      const ctx = props.ctx
      const tab = props.useTabInfo().tab
      const sessionId = props.sessionId ?? tab.sessionId

      const [state, setState] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [confirmClear, setConfirmClear] = useState(false)
      const [showAll, setShowAll] = useState(null)

      const load = useCallback(
        async (options = {}) => {
          if (options.quiet !== true) setPhase('loading')
          try {
            const data = await rpc(ACTIONS.TRASH_LIST, { sessionId, ...(options.all === undefined ? {} : { all: options.all }) }, tab.signal)
            setState(data)
            setShowAll(data.showAll === true)
            setError(null)
            setPhase('ready')
          } catch (failure) {
            if (failure?.name === 'AbortError') return
            setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
            setPhase('error')
          }
        },
        [sessionId, tab.signal],
      )

      const wasVisible = useRef(false)
      useEffect(() => {
        const visible = tab.visible !== false
        if (!wasVisible.current || visible) {
          wasVisible.current = true
          void load({ quiet: state !== null })
        }
      }, [tab.visible, sessionId])

      useEffect(() => tab.actions.bindCommands({ refresh: () => void load({ quiet: true }) }), [tab.actions, load])

      const openEntry = useCallback(
        (entry) => {
          ctx.sidebarRight.openResourceIn(sessionId, DIFF_ADDRESS, {
            params: { source: 'trash', id: entry.id, revision: Date.now() },
          })
        },
        [ctx, sessionId],
      )

      const removeEntry = useCallback(
        async (entry) => {
          setBusy(entry.id)
          try {
            await rpc(ACTIONS.TRASH_DELETE, { sessionId, id: entry.id }, tab.signal)
            await load({ quiet: true })
          } catch (failure) {
            if (failure?.name !== 'AbortError') setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
          } finally {
            setBusy(null)
          }
        },
        [sessionId, load, tab.signal],
      )

      const clearAll = useCallback(async () => {
        setConfirmClear(false)
        setBusy('clear')
        try {
          await rpc(ACTIONS.TRASH_CLEAR, { sessionId, all: showAll === true }, tab.signal)
          await load({ quiet: true })
        } catch (failure) {
          if (failure?.name !== 'AbortError') setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
        } finally {
          setBusy(null)
        }
      }, [sessionId, showAll, load, tab.signal])

      const toggleShowAll = useCallback(
        async (next) => {
          setShowAll(next)
          try {
            await rpc(ACTIONS.PREFS, { sessionId, trashShowAllRepos: next }, tab.signal)
          } catch {
            // A preference that failed to persist is not worth an error banner.
          }
          await load({ quiet: true, all: next })
        },
        [sessionId, load, tab.signal],
      )

      if (state === null && phase !== 'error') {
        return h('div', { className: 'gitbar-root', 'data-gitbar-trash': 'loading' }, h(Spinner, { label: t('state.loading') }))
      }
      if (state === null) {
        return h('div', { className: 'gitbar-root', 'data-gitbar-trash': 'error' }, [
          h(Banner, { key: 'b', tone: 'error', text: errorText(t, error?.code, error?.message) }),
          h('div', { key: 'a', className: 'gitbar-picker' }, h('button', { type: 'button', className: 'gitbar-btn', onClick: () => void load() }, t('state.retry'))),
        ])
      }

      const entries = state.entries ?? []
      const now = Date.now()

      return h('div', { className: 'gitbar-root', 'data-gitbar-trash': 'ready', style: { position: 'relative' } }, [
        h('div', { key: 'head', className: 'gitbar-head' }, [
          h('div', { key: 'ident', className: 'gitbar-ident' }, [
            h('span', { key: 'title', className: 'gitbar-repo' }, t('trash.title')),
            h('span', { key: 'count', className: 'gitbar-branch' }, t('trash.count', { n: entries.length })),
          ]),
          h('div', { key: 'tools', className: 'gitbar-tools' }, [
            h(IconButton, { key: 'refresh', label: t('action.refresh'), disabled: busy !== null, onClick: () => void load({ quiet: true }) }, h(RefreshGlyph, {})),
          ]),
        ]),

        error === null ? null : h(Banner, { key: 'err', tone: 'error', text: errorText(t, error.code, error.message), onClose: () => setError(null), closeLabel: t('action.cancel') }),

        h('div', { key: 'sub', className: 'gitbar-sub' }, [
          h('label', { key: 'toggle', className: 'gitbar-toggle' }, [
            h('input', {
              type: 'checkbox',
              checked: showAll === true,
              'data-gitbar-showall': '',
              onChange: (event) => void toggleShowAll(event.target.checked),
            }),
            h('span', { key: 'l' }, showAll === true ? t('trash.showAll') : t('trash.onlyThis')),
          ]),
          h('span', { key: 'spacer', className: 'gitbar-spacer' }),
          h(
            'button',
            {
              key: 'clear',
              type: 'button',
              className: 'gitbar-btn gitbar-btn-danger',
              disabled: entries.length === 0 || busy !== null,
              'data-gitbar-clear': '',
              onClick: () => setConfirmClear(true),
            },
            t('action.clear'),
          ),
        ]),

        h(
          'div',
          { key: 'list', className: 'gitbar-list', 'data-gitbar-trashlist': '' },
          entries.length === 0
            ? h('div', { className: 'gitbar-empty' }, t('trash.empty'))
            : entries.map((entry) => {
                const added = (entry.files ?? []).reduce((sum, file) => sum + (file.added ?? 0), 0)
                const deleted = (entry.files ?? []).reduce((sum, file) => sum + (file.deleted ?? 0), 0)
                const base = entry.base === null || entry.base === undefined ? '' : `#${entry.base.short ?? ''}`
                return h('div', { key: entry.id, className: 'gitbar-row', style: { alignItems: 'stretch', padding: 0 } }, [
                  h(
                    'button',
                    {
                      key: 'open',
                      type: 'button',
                      className: 'gitbar-trashRow',
                      'data-gitbar-entry': entry.id,
                      title: t('diff.trashEntry'),
                      onClick: () => openEntry(entry),
                    },
                    h('span', { className: 'gitbar-trashBody' }, [
                      h('span', { key: 'head', className: 'gitbar-trashHead' }, [
                        h('span', { key: 'when', className: 'gitbar-trashWhen' }, formatRelative(entry.at, now, t)),
                        h(
                          'span',
                          { key: 'scope', className: 'gitbar-badge' },
                          entry.scope === 'all' ? t('trash.scope.all') : t('trash.scope.file'),
                        ),
                        entry.truncated === true ? h('span', { key: 'trunc', className: 'gitbar-badge' }, '…') : null,
                      ]),
                      h(
                        'span',
                        { key: 'detail', className: 'gitbar-trashMeta' },
                        t('trash.detail', { files: (entry.files ?? []).length, added, deleted }),
                      ),
                      h(
                        'span',
                        { key: 'base', className: 'gitbar-trashFiles' },
                        [base === '' ? '' : t('trash.base', { commit: base }), entry.base?.subject === undefined ? '' : ` · ${entry.base.subject}`].join(''),
                      ),
                      h(
                        'span',
                        { key: 'files', className: 'gitbar-trashFiles', title: (entry.files ?? []).map((file) => file.path).join('\n') },
                        (entry.files ?? []).map((file) => shortPath(file.path)).slice(0, 3).join(' · '),
                      ),
                    ]),
                  ),
                  h(
                    'span',
                    { key: 'del', style: { flex: 'none', display: 'flex', alignItems: 'flex-start', padding: '7px 6px 0 0' } },
                    h(
                      IconButton,
                      {
                        label: t('action.delete'),
                        disabled: busy !== null,
                        onClick: () => void removeEntry(entry),
                        attrs: { 'data-gitbar-trashtrash': entry.id },
                      },
                      h(TrashGlyph, { size: 14 }),
                    ),
                  ),
                ])
              }),
        ),

        confirmClear
          ? h('div', { className: 'gitbar-overlay', 'data-gitbar-dialog': 'clear' }, [
              h('div', { className: 'gitbar-dialog', role: 'dialog', 'aria-modal': 'true' }, [
                h('div', { key: 'title', className: 'gitbar-dialogTitle' }, t('trash.clearConfirm', { n: entries.length })),
                h('div', { key: 'hint', className: 'gitbar-checkHint' }, t('trash.clearHint')),
                h('div', { key: 'actions', className: 'gitbar-dialogActions' }, [
                  h('button', { key: 'cancel', type: 'button', className: 'gitbar-btn', onClick: () => setConfirmClear(false) }, t('action.cancel')),
                  h(
                    'button',
                    { key: 'go', type: 'button', className: 'gitbar-btn gitbar-btn-danger', 'data-gitbar-clearcancel': '', onClick: () => void clearAll() },
                    t('action.clear'),
                  ),
                ]),
              ]),
            ])
          : null,
      ])
    }

    /* ------------------------------------------------------------------ *
     * 10. The diff tab
     * ------------------------------------------------------------------ */

    /** Whatever the diff tab was last asked to show. */
    function diffTarget(params) {
      if (params === null || typeof params !== 'object') return null
      if (params.source === 'trash' && typeof params.id === 'string' && params.id !== '') {
        return { source: 'trash', id: params.id }
      }
      if (typeof params.path === 'string' && params.path !== '') {
        return { source: 'worktree', path: params.path }
      }
      return null
    }

    function DiffBody(props) {
      const t = props.t ?? fallbackTranslate()
      const tab = props.useTabInfo().tab
      const sessionId = props.sessionId ?? tab.sessionId
      const navigation = tab.navigation ?? {}
      const target = diffTarget(navigation.params)
      const revision = navigation.revision ?? 0

      const [state, setState] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        if (target === null) {
          setState({ text: '', added: 0, deleted: 0, binary: false, truncated: false })
          setPhase('ready')
          return
        }
        setPhase('loading')
        try {
          if (target.source === 'trash') {
            const data = await rpc(ACTIONS.TRASH_DIFF, { sessionId, id: target.id }, tab.signal)
            setState({ text: data.text, added: 0, deleted: 0, binary: false, truncated: data.entry?.truncated === true })
          } else {
            const data = await rpc(ACTIONS.FILE_DIFF, { sessionId, path: target.path }, tab.signal)
            setState(data.diff)
          }
          setError(null)
          setPhase('ready')
        } catch (failure) {
          if (failure?.name === 'AbortError') return
          setError({ code: failure.code ?? 'E_UNKNOWN', message: failure.message })
          setPhase('error')
        }
      }, [sessionId, tab.signal, target?.source, target?.id, target?.path, revision])

      useEffect(() => {
        void load()
      }, [load])

      useEffect(() => tab.actions.bindCommands({ refresh: () => void load() }), [tab.actions, load])

      const rows = useMemo(() => (state === null ? [] : diffRows(state.text)), [state])

      if (phase === 'loading' && state === null) {
        return h('div', { className: 'gitbar-root', 'data-gitbar-diff': 'loading' }, h(Spinner, { label: t('diff.loading') }))
      }
      if (phase === 'error') {
        return h('div', { className: 'gitbar-root', 'data-gitbar-diff': 'error' }, [
          h(Banner, { key: 'b', tone: 'error', text: errorText(t, error?.code, error?.message) }),
          h('div', { key: 'a', className: 'gitbar-picker' }, h('button', { type: 'button', className: 'gitbar-btn', onClick: () => void load() }, t('state.retry'))),
        ])
      }

      const empty = state === null || state.text === ''

      return h('div', { className: 'gitbar-root', 'data-gitbar-diff': 'ready' }, [
        h('div', { key: 'head', className: 'gitbar-head' }, [
          h('div', { key: 'ident', className: 'gitbar-ident' }, [
            h(
              'span',
              { key: 'name', className: 'gitbar-repo', title: target?.path ?? '' },
              target === null ? t('diff.title') : target.source === 'trash' ? t('diff.trashEntry') : splitPath(target.path).name,
            ),
            target === null || target.source === 'trash' ? null : h('span', { key: 'dir', className: 'gitbar-branch' }, splitPath(target.path).dir),
          ]),
          h('div', { key: 'tools', className: 'gitbar-tools' }, [
            h(
              'span',
              { key: 'stats', className: 'gitbar-stats', style: { marginRight: 4 } },
              [
                (state?.added ?? 0) > 0 ? h('span', { key: 'p', className: 'gitbar-plus' }, `+${state.added}`) : null,
                (state?.deleted ?? 0) > 0 ? h('span', { key: 'm', className: 'gitbar-minus' }, `−${state.deleted}`) : null,
              ],
            ),
            h(IconButton, { key: 'refresh', label: t('action.refresh'), onClick: () => void load() }, h(RefreshGlyph, {})),
          ]),
        ]),

        state?.truncated === true ? h(Banner, { key: 'trunc', tone: 'warn', text: t('diff.truncated') }) : null,
        state?.binary === true ? h(Banner, { key: 'bin', tone: 'warn', text: t('diff.binary') }) : null,

        empty
          ? h('div', { key: 'empty', className: 'gitbar-empty' }, t('diff.empty'))
          : h(
              'div',
              { key: 'body', className: 'gitbar-diff', 'data-gitbar-diffbody': '' },
              rows.map((row, index) => {
                const key = `${index}`
                if (row.kind === 'file' || row.kind === 'hunk' || row.kind === 'meta' || row.kind === 'note') {
                  return h('div', { key, className: `gitbar-diffRow gitbar-r-${row.kind}` }, [
                    h('span', { key: 'g', className: 'gitbar-gutter' }, [h('span', { key: 'a' }, ''), h('span', { key: 'b' }, '')]),
                    h('span', { key: 'c', className: 'gitbar-code' }, row.text),
                  ])
                }
                const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
                return h('div', { key, className: `gitbar-diffRow gitbar-r-${row.kind}` }, [
                  h('span', { key: 'g', className: 'gitbar-gutter' }, [
                    h('span', { key: 'a' }, row.kind === 'add' ? '' : String(row.oldLine ?? '')),
                    h('span', { key: 'b' }, row.kind === 'del' ? '' : String(row.newLine ?? '')),
                  ]),
                  h('span', { key: 'c', className: 'gitbar-code' }, `${mark}${row.text}`),
                ])
              }),
            ),
      ])
    }

    /* ------------------------------------------------------------------ *
     * 11. Tab titles
     * ------------------------------------------------------------------ */

    /** The panel's chip: the branch mark plus the panel name. */
    function GitTitle(props) {
      const t = props.t ?? fallbackTranslate()
      return h('span', { className: 'gitbar-tabTitle' }, [
        h(GitGlyph, { key: 'g', size: 14 }),
        h('span', { key: 'l', className: 'gitbar-tabTitleText' }, t('panel.title')),
      ])
    }

    /** The trash chip. */
    function TrashTitle(props) {
      const t = props.t ?? fallbackTranslate()
      return h('span', { className: 'gitbar-tabTitle' }, [
        h(ArchiveGlyph, { key: 'g', size: 14 }),
        h('span', { key: 'l', className: 'gitbar-tabTitleText' }, t('trash.title')),
      ])
    }

    /**
     * The diff chip.
     *
     * Registered as a seat rather than left to the definition's `title(address)`
     * on purpose: a captured title never changes, and this tab is re-navigated
     * in place — so it has to read the live `navigation.params` to name the file
     * currently on screen.
     */
    function DiffTitle(props) {
      const t = props.t ?? fallbackTranslate()
      const tab = props.useTabInfo().tab
      const target = diffTarget(tab.navigation?.params)
      const label =
        target === null
          ? t('diff.title')
          : target.source === 'trash'
            ? t('diff.trashEntry')
            : splitPath(target.path).name
      return h('span', { className: 'gitbar-tabTitle' }, [
        h(ChevronRightGlyph, { key: 'g', size: 14 }),
        h('span', { key: 'l', className: 'gitbar-tabTitleText' }, label),
      ])
    }

    /* ------------------------------------------------------------------ *
     * 12. Install
     * ------------------------------------------------------------------ */

    /**
     * @param {object} ctx client context
     */
    function apply(ctx) {
      ensureStyle()

      // The dictionaries go to the locale service when there is one; the inline
      // table is the fallback for a composition without it.
      const locale = ctx.locale
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'dsh-gitbar-lite: copy')
      }
      const t = locale !== undefined && typeof locale.bind === 'function' ? locale.bind(NS) : fallbackTranslate()

      /**
       * Inject the context plus a bound translator into every body, and the
       * session id when the seat has one.
       *
       * `ctx` is handed over explicitly because a slot's standard props carry no
       * context — the same reason the shipped settings row does it.
       */
      const injectFor = () => ({ ctx, t })

      /* --- the panel ----------------------------------------------------- */

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: GIT_ID,
            kind: GIT_KIND,
            title: () => t('panel.title'),
            // The panel keeps its ticks and its half-written Summary while the
            // user peeks at a diff in the next tab along.
            keepMounted: true,
            guide: [
              {
                id: 'changes',
                order: GUIDE_ORDER,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
                icon: GuideGlyph,
              },
            ],
          }),
        'dsh-gitbar-lite: panel type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: GIT_ID,
                locale: NS,
                inject: (sessionId) => injectFor(sessionId),
              },
              GitBody,
            ),
          ),
        'dsh-gitbar-lite: panel body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: GIT_ID, locale: NS, inject: () => ({ t }) },
              GitTitle,
            ),
          ),
        'dsh-gitbar-lite: panel title',
      )

      /* --- the trash ----------------------------------------------------- */

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TRASH_ID,
            kind: TRASH_KIND,
            title: () => t('trash.title'),
          }),
        'dsh-gitbar-lite: trash type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TRASH_ID,
                locale: NS,
                inject: (sessionId) => injectFor(sessionId),
              },
              TrashBody,
            ),
          ),
        'dsh-gitbar-lite: trash body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: TRASH_ID, locale: NS, inject: () => ({ t }) },
              TrashTitle,
            ),
          ),
        'dsh-gitbar-lite: trash title',
      )

      /* --- the diff tab, a singleton by address -------------------------- */

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: DIFF_ID,
            kind: DIFF_KIND,
            patterns: [DIFF_PATTERN],
            canOpen: (address) => address === DIFF_ADDRESS || address.startsWith(`${DIFF_ADDRESS}/`),
            // Never seen: the live chip comes from the title seat below.
            title: () => t('diff.title'),
          }),
        'dsh-gitbar-lite: diff type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: DIFF_ID,
                locale: NS,
                inject: (sessionId) => injectFor(sessionId),
              },
              DiffBody,
            ),
          ),
        'dsh-gitbar-lite: diff body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: DIFF_ID, locale: NS, inject: () => ({ t }) },
              DiffTitle,
            ),
          ),
        'dsh-gitbar-lite: diff title',
      )
    }

    exports.name = PLUGIN_ID
    // Every one of these is a shipped service of the Web app; without any of
    // them there is no right column to put a tab in.
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    exports.apply = apply

    /**
     * Internals the test suite drives directly.
     *
     * The pure helpers are exported rather than duplicated in the tests, so a
     * change to the diff renderer cannot pass a stale expectation.
     */
    exports.internals = {
      RPC_ROUTE,
      ACTIONS,
      NS,
      GIT_ID,
      GIT_KIND,
      TRASH_ID,
      TRASH_KIND,
      DIFF_ID,
      DIFF_KIND,
      DIFF_ADDRESS,
      DIFF_PATTERN,
      ZH,
      EN,
      diffRows,
      statusLetter,
      splitPath,
      formatRelative,
      stagedCount,
      hasConflict,
      contextLabelKey,
      contextAction,
      diffTarget,
      commitReadiness,
      interpolate,
      errorText,
      // The pieces with no hooks in them, so the suite can assert what they
      // render without a DOM: a tick's state, the confirmation's default, and
      // the picker's candidates are all pure functions of their props.
      ChangeRow,
      DiscardDialog,
      RepositoryPicker,
      Banner,
    }

    return module.exports
  },
})
