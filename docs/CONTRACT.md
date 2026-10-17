# dsh-gitbar-lite — implementation contract

This document is the part of the design that is *not* visible from the outside:
the wire between the two halves, where state lives, the invariants the code is
built around, and — just as importantly — what has **not** been verified.

It is written for whoever changes this plugin next, including a future me who has
forgotten why the discard order is what it is.

---

## 1. What this is, and the shape of the split

A GitHub Desktop-shaped Git panel that lives in DSH's built-in right sidebar.
Three tab types, all session-scoped because that is what the right column is:

| Tab | Kind | Address | Opened by |
|---|---|---|---|
| The panel | `gitbar` | page (`sidebar://gitbar`) | the guide card in the right column |
| The trash | `gitbar-trash` | page (`sidebar://gitbar-trash`) | a button in the panel |
| A diff | `gitbar-diff` | **resource** (`dsh-resource://dsh-gitbar-lite/diff/current`) | double-clicking a file, or a trash entry |

The split between the halves is total: the browser half never touches the disk,
never shells out, and never sees a path it did not get from the host.

```
right sidebar tab (browser)            host process
──────────────────────────            ─────────────
GitPanel / TrashBody / DiffBody
        │
        │  POST /api/dsh-gitbar-lite/rpc
        │  { action, ...payload }            connection.fetch.register
        ▼                                    → admit() (fence + cookie)
   createRoute.fetch ─────────────────────►  → createHandlers[action]
                                                   │
                                                   ├─ git.js    ctx.subprocess
                                                   ├─ repo.js   the operations
                                                   └─ store.js  <DSH_HOME>/dsh-gitbar-lite
```

**Why one route and not one action per route.** `connection.fetch` matches on the
exact pathname and method, and every call already carries a `sessionId` plus the
few fields the action needs. One `POST` with an `action` field keeps the wire
contract in one place — mirrored verbatim in the browser half — instead of
spreading fifteen path literals across two languages.

**Why it must be `connection.fetch` and never `webServer.register`.** The web
server resolves `kind: 'exact'` routes *before* its `/api` prefix route, and
everything that makes an `/api` request safe hangs off that prefix route:
`connection.admit(req)` runs the Host/Origin fence and the browser-cookie check
before `bridge()` dispatches. An exact route on the same path shadows all of it,
turning this into an unauthenticated git surface reachable by anything that can
guess the path. `test/index.test.mjs` and `test/check.mjs` both assert the
carrier, and the check script proves its own assertion is sensitive by running
the predicate against a deliberately broken copy of the source.

---

## 2. The wire contract

`POST /api/dsh-gitbar-lite/rpc`, body `{ action, ...payload }`, `requestBody:
'buffered'`.

Every response is JSON with `cache-control: no-store`. Success is
`{ ok: true, ...data }`. Failure is `{ ok: false, error: { code, message } }`
**and** a meaningful HTTP status — both, on purpose, because the browser half
reads the body and a non-2xx status must not be the only signal. The `message`
the host sends is already user-facing (Chinese), and the browser half localises
`code` when it recognises it, falling back to that message.

### Actions

| action | payload | returns |
|---|---|---|
| `status` | `sessionId` | the whole panel state (see below), or the picker's candidate list when nothing is bound |
| `bind` | `sessionId`, `repoRoot: string \| null` | `{ repoRoot, bound }` or `{ cleared: true }` |
| `repos` | `sessionId` | `{ candidates, scanned, scanTruncated, repoRoot, source }` |
| `stage` | `sessionId`, `paths: string[]`, `staged: boolean` | fresh status |
| `commit` | `sessionId`, `summary`, `description?` | `{ commit, ...status }` |
| `commitAndPush` | same | `{ commit, push: { ok, ... } , ...status }` |
| `push` | `sessionId` | `{ action: 'push', outcome, ...status }` |
| `fetch` | `sessionId` | `{ action: 'fetch', outcome, ...status }` |
| `discard` | `sessionId`, `paths: string[] \| null`, `hardDelete` | `{ discard, ...status }` |
| `fileDiff` | `sessionId`, `path` | `{ diff }` |
| `trashList` | `sessionId`, `all?` | `{ entries, total, showAll, repoRoot }` |
| `trashDiff` | `id` | `{ entry, text }` |
| `trashDelete` | `id` | `{ removed }` |
| `trashClear` | `sessionId`, `all?` | `{ removed }` |
| `prefs` | `sessionId`, `trashHardDelete?`, `trashShowAllRepos?` | `{ prefs }` |

`paths: null` on `discard` means *every changed file*; an explicit array means
exactly those paths. An array that matches nothing is an `E_BAD_REQUEST`, and a
clean working tree is refused too, so "discard nothing" never writes an empty
archive.

### The status payload

```
{
  workspacePath, workspaceTitle, source: 'binding' | 'detected' | 'none',
  repoRoot, repoName, head: { oid, short, subject },
  branch: { oid, head, upstream, ahead, behind, detached, unborn },
  remotes: string[],
  files: [{ path, origPath?, index, worktree, kind, untracked, conflicted,
            staged, partial, added, deleted, binary, synthesized? }],
  counts: { files, staged, partial, conflicted, additions, deletions },
  primary: 'push' | 'publish' | 'fetch',
  prefs: { trashHardDelete, trashShowAllRepos }
}
```

`head` is the commit a discarded diff would be taken *against*, which is why the
trash can say "against `a1b2c3d` *init*" and mean it.

### Failure codes

`E_BAD_REQUEST` · `E_UNKNOWN_ACTION` · `E_NO_WORKSPACE` · `E_NO_REPO` ·
`E_NO_GIT` · `E_EMPTY_SUMMARY` · `E_NOTHING_STAGED` · `E_CONFLICT` ·
`E_GIT_FAILED` · `E_NO_REMOTE` · `E_NO_UPSTREAM` · `E_AUTH` · `E_PUSH_REJECTED` ·
`E_TRASH_NOT_FOUND` · `E_INTERNAL`.

`E_AUTH` and `E_PUSH_REJECTED` exist so the panel can say the one useful
sentence for each instead of pasting git's stderr. Both are derived by pattern
matching git's output in `classifyGitFailure`, which reads **stdout as well as
stderr** — `git commit` with nothing staged exits 1 with an empty stderr and
"nothing to commit" on stdout, and a stderr-only matcher reports that as an
unexplained internal failure.

---

## 3. Where state lives

`<DSH_HOME>/dsh-gitbar-lite/`, falling back to `~/.dsh`. **Do not read
`$DSH_HOME` alone**: the Host process usually does not have it set (the variable
belongs to the shell DSH spawns), so a state file written under a bare
`process.env.DSH_HOME` lands somewhere else or fails to resolve at all. This is
the same trap `dsh-tailscale-remote` documents.

```
bindings.json   { version, bindings: { <canonical workspace path>: { repoRoot, workspacePath, updatedAt } } }
prefs.json      { version, trashHardDelete, trashShowAllRepos }
trash/index.json  { version, entries: [ ... ] }
trash/<id>.diff   the archived diff, one file per discard operation
```

Every write goes through a temp file plus a rename, so a crash mid-write cannot
truncate a file, and every read-modify-write is serialized per path — two tabs
issuing overlapping mutations is the normal case here, not an edge case.

**Why not the settings service or a storage domain.** A binding is keyed by an
arbitrary absolute workspace path, and a `storageDomain` record key is restricted
to `^[a-zA-Z0-9_-]+$` because it becomes a path segment; `C:\Users\…\<a folder
with spaces>` cannot be one without hashing it, at which point the "native"
option is doing less than the twelve lines here. A settings `Config` would put a
growing map of machine paths into the user-visible settings form, which is worse.

**The binding key** is canonical, separator-normalized, and case-folded on
Windows (`workspaceKey`), so `C:\Foo\`, `C:\Foo` and `c:\foo` are one record. The
original spelling is stored alongside for display.

**A stale binding is dropped, not reported.** If the bound directory is gone, or
is no longer a repository, `resolveBinding` clears the record and re-detects. A
broken binding the user cannot clear from the UI is worse than re-deciding.

---

## 4. The invariant: a tick *is* the index

This is the claim that makes the plugin safe next to a terminal, and the claim a
pathspec-limited commit would quietly break.

- Ticking a file runs `git add -A -- :(literal)<path>`.
- Unticking runs `git restore --staged -- :(literal)<path>`.
- A file reads as ticked when **all** of its change is in the index
  (`index !== '.'`), and as *indeterminate* when the index and the worktree are
  both dirty (`MM`) — one tick cannot represent half a file, so the box shows a
  dash and either click restates the file as a whole.
- Commit runs a plain `git commit -F -` with **no pathspec**. What the panel
  shows, what `git status` shows, and what gets committed cannot drift apart.
- Untracked and `.gitignore`d files are never ticked: they are not in the index
  and cannot be.

`:(literal)` matters: without it, discarding a file named `docs` would also reach
`docs/anything`, and a file named `a[1].txt` would be treated as a pattern.

The two user-visible consequences, stated plainly: the plugin *does* mutate your
index (that is the point — GitHub Desktop does the same), and a file you staged
by hand shows up ticked, because it is.

---

## 5. Discarding, in order, and why

```
1. read the full status                      ── decide the target set
2. refuse if any target is conflicted        ── E_CONFLICT, one sentence
3. build the archive                         ── BEFORE anything is destroyed
     tracked:   git diff --no-color --find-renames HEAD -- <literal paths>
                (+ git diff --numstat … in the same round, for the per-file table)
     untracked: synthesizeNewFileDiff per path, from the file's own bytes
4. cap it on a line boundary                 ── limitDiff, records droppedLines
5. write the trash entry + blob              ── unless hardDelete
6. restore
     tracked:   git restore --source=HEAD --staged --worktree -- <literal paths>
     untracked: delete the file, then prune directories the discard emptied
```

Steps 3 and 6 are not interchangeable. `git restore` destroys the original, so
the archive has to exist first; that is the whole reason the plugin has a trash.

**Why tracked and untracked are restored by different means.** A mixed
pathspec — one untracked path alongside tracked ones — makes the *entire*
`git restore` fail with `pathspec … did not match any file(s) known to git` and
restores nothing (verified on git 2.54). Splitting them is not tidiness; it is
correctness.

**Why untracked paths are deleted rather than restored.** They are not in HEAD,
so `git restore --source=HEAD` cannot reach them. Their content is captured in
step 3 or lost, which is exactly why the synthesized diff exists.

**One entry per discard operation, not one per file.** Discarding a single file
archives one blob with one file in it; "Discard all" archives **one blob holding
every file's diff**, with `scope: 'all'`. That is what was asked for, and it also
means a whole-tree discard is one write rather than N.

**Conflicts are refused, not resolved.** Discarding a conflicted path would mean
`git restore` against HEAD in the middle of a merge, which can disturb the merge
state. The panel says one sentence instead, and `test/e2e.mjs` S12 proves both
the single-file and the discard-all paths refuse.

**`hardDelete` is a per-operation choice, remembered.** The confirmation box's
"delete for good" starts unticked for a first-time user (the safe answer keeps a
copy) and is persisted after each discard, so it mirrors the user's last
decision rather than latching.

---

## 6. The trash

An entry records, so that a diff can still be read months later:

```
{ id, at, repoRoot, repoName, workspacePath, sessionId,
  scope: 'file' | 'all',
  branch: { head, detached },
  base: { oid, short, subject } | null,     ← the commit the diff is against
  files: [{ path, origPath?, kind, added, deleted, binary, synthesized?, oversized? }],
  bytes, truncated, droppedLines, blob }
```

`base` is HEAD at the moment of the discard. That is the answer to "which version
is this a diff against" — and it is recorded rather than inferred, because HEAD
moves.

The list is filtered to the currently bound repository by default; `total` still
reports the whole index, and a toggle shows everything. Clearing with the filter
on clears only the visible repository's entries.

Reading an entry whose `.diff` was deleted by hand still lists it: the metadata
is worth keeping even when the blob is gone, and the read reports the blob as
missing rather than pretending the entry vanished.

---

## 7. The right-sidebar tab identities

```
id:   dsh-gitbar-lite/git     kind: gitbar         page   keepMounted, one guide card (order 30)
id:   dsh-gitbar-lite/trash   kind: gitbar-trash   page
id:   dsh-gitbar-lite/diff    kind: gitbar-diff    resource, patterns: dsh-resource://dsh-gitbar-lite/diff/**
```

`definition.id` is **also the slot key** the body and title register under. Two
consequences the code leans on: a rename in one place without the other silently
renders nothing, and `test/client.test.mjs` asserts every slot key is one of the
three ids.

**Why the diff tab is a resource with a fixed address.** Re-opening a resource
address reveals the tab that is already open — the host looks the content id up
across the whole layout before planning a new tab — and the `params` payload
re-navigates that tab (each open bumps `navigation.revision`). A page kind would
reuse only within the active dock pane, so a tab the user had floated would get a
second copy. The fixed address *is* the "one diff tab, ever" requirement, and the
diff's own chip is a title seat because it has to read the live
`navigation.params` to name the file currently on screen — a title captured at
open time never changes.

**Why `keepMounted` on the panel and not the trash.** The panel holds the tick
state that mirrors the index and a half-written Summary; peeking at a diff must
not lose either. The trash holds only what it re-reads on every visit, so
retaining it would buy nothing.

**The panel re-reads on `tab.visible`.** Coming back to the panel refreshes
quietly, because the working tree may have changed under it — an agent in the
same session is a normal author of those changes.

---

## 8. Configuration

Every field is volatile, which is what lets the settings page edit them without a
restart — and is why `cordis.patch.yml` deliberately carries **no** `config`
block: values written into the profile's own patch layer must not be shadowed by
this package on the next upgrade.

| field | default | why |
|---|---|---|
| `gitPath` | `''` | Empty means "whatever is on PATH". Set it when git is somewhere unusual. |
| `stateDir` | `''` | Empty means `<DSH_HOME>/dsh-gitbar-lite`. |
| `timeoutMs` | `30000` | Per-command. A push to a slow remote may need more. |
| `maxDiffBytes` | `524288` | Ceiling on one archived diff. A discarding user is having a bad day already; a 200 MB generated file must not become a 200 MB write that then fails. |
| `maxFileBytes` | `2097152` | Larger untracked files are listed but their content is not read, archived, or diffed. |
| `trashLimit` | `200` | Entries kept; the oldest are dropped and their blobs deleted. |
| `scanDepth` | `3` | Directory depth the picker scans below the workspace root. |

---

## 9. Verified, and not

### Verified

| what | how |
|---|---|
| porcelain v2 parsing, including a rename, a staged delete, a conflict, a non-UTF-8-hostile path, and a path containing a space | `test/parse.test.mjs`, 47 cases; the conflict fixture pins the nine-field `u` record |
| diff assembly, truncation on line boundaries, per-file splitting | `test/diff.test.mjs` |
| state files, the binding key, corruption tolerance, write serialization | `test/store.test.mjs` |
| the route carrier, single registration under a hostile service order, error classification | `test/index.test.mjs` |
| every registration identity, the wire literals, the dictionaries, and the hook-free components' rendered trees | `test/client.test.mjs` |
| that every registered seat **renders** — the bodies, hidden states, and no-session states | `test/seats.test.mjs` |
| the whole host stack against **real git**, mutation by mutation | `test/e2e.mjs`, 289 assertions over 23 sections that build their own fixtures |
| the manifest, the patch layer, the tarball's contents, the two copies of the wire contract, the dictionaries, the workflow | `test/check.mjs` |
| that the client bundle would not abort the Host boot | `scripts/check-client-bundle.mjs` |

The e2e suite is deliberately hostile about §4: after ticking one file it reads
`git status --porcelain` back and asserts git agrees, which is the only way to
show the index claim rather than assume it.

### Not verified

- **`ctx.subprocess` is doubled in the tests.** The shipped service lives inside
  DSH's own bundle and is not importable from a plugin repository, so
  `test/helpers/subprocess.mjs` reproduces its shapes on top of
  `node:child_process`. Those shapes are not guessed: the live contract was read
  off a running DSH (Cordis Inspect, host provider `Service`, key `subprocess`)
  and the double is pinned to it — including the part that is easy to get wrong,
  that `spawn` **throws synchronously** for an already-aborted signal, or for an
  argv/cwd/env/grace it rejects, instead of returning a handle. `S20` exists
  because a caller that only `await`s the handle never sees that throw, and it
  used to reach the route layer unclassified. What the double still does **not**
  reproduce: Windows Job containment, the environment scrubbing, spill files
  (`readFrom`'s `spillPath`), and the `control` duplex.
- **What the live run established.** The plugin loads into a running DSH and all
  three right-sidebar seats register and are active — `dsh-gitbar-lite/git` and
  `dsh-gitbar-lite/trash` (pages) and `dsh-gitbar-lite/diff` (resource) — read
  off the live client slot tree at `sidebar.right.pane.tab`, next to the shipped
  occupants. That is evidence about *mounting*; the behaviour claims are the e2e
  suite's job, and the seam between them is the doubled `ctx.subprocess` above.
- **No headless-DOM render test.** The panel, the trash and the diff are driven
  by hooks, and the three components with no hooks in them (the row, the
  confirmation, the picker) *are* asserted on their element trees. What is not
  covered is real layout: whether the panel actually fills the column, whether a
  diff row's background is the token it claims. A browser harness with a
  hand-written React shim would be needed, and the two bugs that motivate one in
  other plugins in this family were both DOM-measurement bugs — this plugin
  measures nothing and augments no host DOM, so the harness was judged not worth
  its fixture-fidelity cost. That judgement is worth revisiting if the UI grows
  anything hover-dependent or portalled.
- **What a 401 from `/api` does and does not prove.** `connection.admit()` — the
  Host/Origin fence and the browser-cookie check — runs on the `/api` prefix
  route *before* dispatch, so an unauthenticated request to a path nobody serves
  answers 401 as well. `test/live.mjs` therefore reports 401 as *inconclusive*
  rather than as "mounted"; only a 200 (or, when authenticated, a 404) is
  evidence about whether this plugin is actually registered.
- **`openTabIn` / `openResourceIn` are outside the published type contract.**
  They are prototype methods on the sidebar-right controller and are called by
  shipped plugins (including `dsh-deepseek-webchat`), but three source comments
  label them "not part of `ISidebarRight`". This is the first thing to re-check
  on a DSH upgrade.
- **`@deepseek-ai/dsh-client-ui-dockkit` was not available to read**, so the tab
  strip's height and the pane's padding could not be confirmed. The styles
  therefore add no top padding and claim only `height: 100%; min-height: 0`, so
  they fill whatever the kit provides instead of guessing.
- **Git's path encoding on this machine.** `core.quotepath=false` plus `-z`
  produced UTF-8 paths in every fixture that was checked (including a non-ASCII
  name), and the parsers split on NUL rather than on quoting. A repository whose
  paths git emits in another encoding is untested.

---

## 10. Known limitations

- One repository per workspace, one workspace per binding. No submodules, no
  worktrees, no multiple remotes beyond "prefer `origin`, else the first".
- Push and Fetch always act on a single remote. There is no branch switching, no
  history list, and no stash — that was the agreed scope.
- `git fetch --prune` is what Fetch does, matching GitHub Desktop. It deletes
  remote-tracking refs whose branch the remote no longer has.
- Commit hooks run. A hook that blocks or hangs is the user's own hook; the child
  is killed at `graceMs` only if the command times out, and `timeoutMs` is the
  knob for that.
- The trash keeps the diffs, not the files. Recovery means applying the archived
  diff by hand; the plugin does not offer a restore button, by agreement.
- Binary content is not archived — the diff says `Binary files … differ`, which
  is honest but is not a backup.
- An untracked file over `maxFileBytes` is deleted with only a stub in the
  archive. The confirmation box does not yet warn about that specifically.
