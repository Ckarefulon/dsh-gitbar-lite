#!/usr/bin/env node
/**
 * The artifact self-check: everything that can be verified offline, about the
 * bytes that would actually be published.
 *
 * It is deliberately not a test runner. `node --test` covers behaviour; this
 * covers *shape* — the manifest, the patch layer, the wire contract as two
 * copies of the same literals, the dictionary files against the inline copy in
 * the bundle, and a handful of source-level invariants that would be expensive
 * to discover at runtime.
 *
 * Two of the assertions are written so their own sensitivity is visible: the
 * predicate is also run against a deliberately broken copy of the source, and
 * asserted to go the other way. An assertion that cannot fail is not an
 * assertion, and this project has already shipped one of those once.
 *
 * Output is ASCII-only, because a Windows console is not guaranteed to decode
 * anything else, and the failure that matters is the one that gets printed.
 *
 * Exit 0 when every check passed, 1 otherwise. Run directly (`node test/check.mjs`).
 *
 * @module dsh-gitbar-lite/test/check
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { Config, internals, name as pluginName } from '../lib/index.js'
import { ACTIONS, DEFAULT_SUMMARY_SCRIPT, DISCARD_SCOPE, ERROR_CODES, PRIMARY_ACTIONS, RPC_ROUTE, STATE_FILES } from '../lib/shared.js'

const root = dirname(import.meta.dirname)

// ------------------------------------------------------------------ harness

let checks = 0
let failures = 0

function section(title) {
  console.log(`\n== ${title}`)
}

function check(label, condition, extra) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  failures += 1
  console.log(`  FAIL ${label}`)
  if (extra !== undefined) console.log(`       ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`)
  return false
}

function eq(label, got, want) {
  return check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function exists(relativePath) {
  return statSync(join(root, relativePath), { throwIfNoEntry: false })?.isFile() === true
}

/**
 * Drop comments before scanning source for a forbidden spelling.
 *
 * Without this, a doc comment that *explains* the hazard ("never register on
 * `webServer.register`") reads as an instance of the hazard, and the assertion
 * becomes a check on prose. Block comments and whole-line comments are removed;
 * a trailing `// …` on a line of code is left alone, deliberately, because
 * telling it apart from `http://` needs a lexer and nothing here depends on it.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n')
}

/** The same idea for YAML, where the comment character is `#`. */
function stripYamlComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

// ------------------------------------------------------------------ inputs

const manifest = JSON.parse(read('package.json'))
const shared = read('lib/shared.js')
const client = read('lib/client.js')
const hostIndex = read('lib/index.js')
const patch = read('cordis.patch.yml')
const readme = read('README.md')
const readmeEn = read('README.en.md')
const localeZh = JSON.parse(read('locale/zh.json'))
const localeEn = JSON.parse(read('locale/en.json'))

/** Every host module, concatenated — for the source-level invariants. */
const hostModules = readdirSync(join(root, 'lib', 'host'))
  .filter((file) => file.endsWith('.js'))
  .sort()
  .map((file) => read(join('lib', 'host', file)))
  .join('\n')

/** The same two host sources with their comments removed, for the scans below. */
const hostIndexCode = stripComments(hostIndex)
const hostModulesCode = stripComments(hostModules)

// ------------------------------------------------------- 1. the manifest

section('1. the manifest names real files, and the tarball would carry them')

const exportTargets = Object.entries(manifest.exports)
for (const [key, value] of exportTargets) {
  const target = typeof value === 'string' ? value : value?.default
  check(`exports["${key}"] names a string`, typeof target === 'string')
  check(`exports["${key}"] -> ${target} is a real file`, exists(target))
}

check('the package is not private, so npm publish would accept it', manifest.private === undefined)
eq('main points at the host half', manifest.main, manifest.exports['.'])
check('publishConfig publishes publicly to the public registry', manifest.publishConfig?.access === 'public')
check('publishConfig names the registry explicitly', /registry\.npmjs\.org/.test(manifest.publishConfig?.registry ?? ''))
check('the repository, homepage and bugs URLs all name the package', [manifest.repository?.url, manifest.homepage, manifest.bugs?.url].every((url) => typeof url === 'string' && url.includes(manifest.name)))
eq('dsh.bundle.patch points at the patch file', manifest.dsh?.bundle?.patch, './cordis.patch.yml')
eq('dsh.client.platform is web', manifest.dsh?.client?.platform, 'web')
check('icon.svg is declared and exists', manifest.icon === './icon.svg' && exists('./icon.svg'))

// The shipped `files` list is the real packaging filter: a file the runtime
// reads but `files` omits is present in the repo and absent from the tarball.
const filesPatterns = manifest.files ?? []
const covered = (relativePath) =>
  filesPatterns.some((pattern) => {
    if (pattern.endsWith('/*')) return relativePath.startsWith(pattern.slice(0, -1))
    if (pattern.endsWith('/**')) return relativePath.startsWith(pattern.slice(0, -2))
    return relativePath === pattern || relativePath.startsWith(`${pattern}/`)
  })
for (const needed of [
  './lib/index.js',
  './lib/shared.js',
  './lib/host/routes.js',
  './lib/client.js',
  './cordis.patch.yml',
  './locale/zh.json',
  './locale/en.json',
  './icon.svg',
  './README.md',
  './README.en.md',
  './docs/CONTRACT.md',
  './LICENSE',
]) {
  const relativePath = needed.replace(/^\.\//, '')
  check(`the tarball would carry ${relativePath}`, covered(relativePath))
}
check('the tarball would NOT carry the tests', !covered('test/check.mjs') && !covered('test/e2e.mjs'))
// A relative link in a published README only resolves if the target is shipped.
for (const label of ['README.md', 'README.en.md']) {
  for (const match of read(label).matchAll(/\]\(\.\/([^)#]+)\)/g)) {
    check(`${label}'s link to ${match[1]} points at a shipped file`, covered(match[1].replace(/^\.\//, '')))
  }
}

// ------------------------------------------- 2. the patch layer

section('2. the cordis patch layer inserts one row and nothing else')

const patchLines = patch.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
eq('one insert block', patchLines.length, 3)
check('it opens an insert block', /^-\s*insert:$/.test(patchLines[0]))
eq('the row id and name are both the package name', [
  /^\s*-\s*id:\s*(\S+)\s*$/.exec(patchLines[1])?.[1],
  /^\s*name:\s*'?([^'\s]+)'?\s*$/.exec(patchLines[2])?.[1],
], [manifest.name, manifest.name])
check('it carries no config block, so profile edits are not shadowed', !/^\s*config:/m.test(patch))
check('no credential is committed in the patch', !/(token|secret|password|api[-_]?key)/i.test(patch))
check('no host path is committed in the patch', !/[A-Za-z]:\\/.test(patch))

// ------------------------------------------- 3. the wire contract, twice

section('3. the browser half repeats the wire contract verbatim')

check('the client registers its factory under the manifest name', client.includes(`id: '${manifest.name}'`))
check('the client uses the same RPC route literal', client.includes(`'${RPC_ROUTE}'`))
const missingActions = Object.values(ACTIONS).filter((action) => !client.includes(`'${action}'`))
eq('the client names every action the host dispatches', missingActions, [])
const missingCodes = Object.values(ERROR_CODES).filter((code) => !client.includes(code))
eq('the client knows every failure code', missingCodes, [])
const missingPrimary = Object.values(PRIMARY_ACTIONS).filter((value) => !client.includes(`'${value}'`))
eq('the client knows every context-button state', missingPrimary, [])
const missingScope = Object.values(DISCARD_SCOPE).filter((value) => !client.includes(`'${value}'`))
eq('the client knows both discard scopes', missingScope, [])
check('the client repeats the plugin id', client.includes(`'${pluginName}'`))
check('the client never invents a second route', (client.match(/\/api\//g) ?? []).length === 1)
check('the client does not know where state is kept, only the host does', !client.includes('bindings.json') && !client.includes('trash/index.json'))

// The starting-point script exists twice — once in `shared.js` for the host, once
// inline in the bundle, which cannot import. A one-character drift between them
// would make the box prefill one thing and the host run another, so the two are
// compared as *values*: the source text differs legitimately (the two files quote
// the shell differently), so comparing it would fail on a correct pair.
{
  const declaration = 'const DEFAULT_SUMMARY_SCRIPT ='
  const start = client.indexOf(declaration)
  const end = start === -1 ? -1 : client.indexOf('\n\n', start)
  let mirrored = null
  if (start !== -1 && end !== -1) {
    const expression = client.slice(start + declaration.length, end)
    try {
      // The right-hand side is a plain string-concatenation expression.
      mirrored = new Function(`return (${expression})`)()
    } catch {
      mirrored = null
    }
  }
  eq('the client carries the same default script as the host', mirrored, DEFAULT_SUMMARY_SCRIPT)
}
check('and the host declares those names in one place', Object.values(STATE_FILES).every((name) => shared.includes(name)))

// ------------------------------------------- 4. the host half's own contract

section('4. the host half loads, and its Config is exactly what is documented')

eq('the plugin name is the package name', pluginName, manifest.name)
const defaults = new Config({}).get()
eq('Config has exactly these fields', Object.keys(defaults).sort(), [
  'autoFetchMs',
  'gitPath',
  'maxDiffBytes',
  'maxFileBytes',
  'scanDepth',
  'stateDir',
  'summaryScript',
  'timeoutMs',
  'trashLimit',
])
eq('Config is volatile', Config.meta?.volatile, true)
check('readConfig reads the schema defaults when handed nothing', internals.readConfig(undefined).timeoutMs === defaults.timeoutMs)
check('the default diff cap is a size, not a count', defaults.maxDiffBytes >= 64 * 1024 && defaults.maxDiffBytes <= 4 * 1024 * 1024)
check('the trash limit is positive', defaults.trashLimit > 0)
check('the scan depth is small enough to stay cheap', defaults.scanDepth > 0 && defaults.scanDepth <= 8)

section('5. the host half cannot be talked into bypassing the fence')
{
  /** Does the code register anything on the web server? It must not. */
  const registersOnWebServer = (source) => /webServer\s*\.\s*register/.test(source)
  const registersOnConnectionFetch = (source) => /connection\.fetch\.register|routes\.register/.test(source)

  check('the host registers on connection.fetch', registersOnConnectionFetch(hostIndexCode))
  check('the host never registers a webServer route', !registersOnWebServer(hostIndexCode))
  check('no host module does either', !registersOnWebServer(hostModulesCode))

  // Sensitivity: the predicate really does notice the dangerous spelling, so the
  // two assertions above are not vacuously true.
  const broken = hostIndexCode.replace('connection.fetch.register', 'webServer.register')
  check('  -> the predicate notices a webServer registration when there is one', registersOnWebServer(broken))
  // And the comment-stripping step is load-bearing, not decoration: the raw
  // source does contain the spelling, in the comment that warns against it.
  check('  -> the raw source does mention it, in the warning comment', registersOnWebServer(hostModules))
  check('  -> which is exactly what stripping comments removes', !registersOnWebServer(hostModulesCode))

  check('the route path sits under the fenced /api prefix', RPC_ROUTE.startsWith('/api/'))
  check('the route path has only path-safe segments', RPC_ROUTE.slice('/api/'.length).split('/').every((segment) => /^[A-Za-z0-9_$.-]+$/.test(segment)))
}

// ------------------------------------------- 6. the client bundle's shape

section('6. the client bundle is a classic script the loader can evaluate')

check('no ESM import', !/^\s*import\s/m.test(client))
check('no ESM export', !/^\s*export\s/m.test(client))
check('it declares its own module shim', /const module = \{ exports: \{\} \}/.test(client))
check('it returns its exports', /return module\.exports/.test(client))
const requires = [...client.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
eq('react is the only module it requires', [...new Set(requires)], ['react'])
check('it injects its stylesheet through a findable marker', /data-gitbar-style/.test(client))
{
  // The loader claims every unmarked <style> present when it materializes the
  // factory, and deletes those on invalidate — so a style injected at factory
  // top level would be adopted by the wrong owner and then removed.
  const applyAt = client.indexOf('function apply(ctx)')
  const calls = [...client.matchAll(/ensureStyle\(\)/g)]
  // One declaration (`function ensureStyle()`) and one call.
  eq('ensureStyle is declared once and called once', calls.length, 2)
  check('it injects its stylesheet inside apply, not at factory top level', applyAt > 0 && calls[1].index > applyAt)
}
check('the stylesheet claims the full height of the tab body', /\.gitbar-root\{[^}]*height:100%/.test(client))
check('the stylesheet declares its own scroll areas, since a tab body has none', /\.gitbar-list\{[^}]*overflow:auto/.test(client) && /\.gitbar-diff\{[^}]*overflow:auto/.test(client))
check(
  'the stylesheet never hard-codes a colour',
  !/(?:^|[{;'\s])(?:color|background|border-color)\s*:\s*(?!var\(|none|inherit|transparent)/m.test(client),
)

// The one place the four kinds of privacy-relevant literal could drift.
section('7. the diff tab is a singleton by address, and says so once')
{
  // Anchored on the quotes so the prose in the header comment — which mentions
  // the scheme by name — is not counted as an address.
  const addresses = [...client.matchAll(/'(dsh-resource:\/\/[^']+)'/g)].map((match) => match[1])
  eq('exactly two resource-address string literals (the address and its pattern)', addresses.length, 2)
  const [address, pattern] = addresses
  check('both name this package', address.includes(manifest.name) && pattern.includes(manifest.name))
  // `**` follows a slash, so it matches whole segments below the parent — which
  // means the address has to be a *child* of the pattern's directory, not the
  // directory itself.
  const parent = `${address.slice(0, address.lastIndexOf('/') + 1)}`
  check('the pattern is the address parent plus a recursive wildcard', pattern === `${parent}**`)
  check('the address has a segment for that wildcard to match', address.length > parent.length)
  check('the tab is opened with params rather than a second address', client.includes('openResourceIn') && !client.includes('openResource('))
  check('the host can address a resource tab back to its file', /source: 'worktree'|source: 'trash'/.test(client))
}

// ------------------------------------------- 8. the dictionaries agree

section('8. the dictionaries, the locale files, and every call site agree')

const zhBlock = /const ZH = \{([\s\S]*?)\n    \}/.exec(client)
const enBlock = /const EN = \{([\s\S]*?)\n    \}/.exec(client)
check('both inline dictionaries are found', zhBlock !== null && enBlock !== null)
const keysOf = (block) => [...block.matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((match) => match[1]).sort()
const zhKeys = keysOf(zhBlock[1])
const enKeys = keysOf(enBlock[1])
eq('the inline zh and en dictionaries have the same keys', zhKeys, enKeys)
check('there are no duplicate keys inside a dictionary', new Set(zhKeys).size === zhKeys.length)

// Every code the host can send has a sentence, in both languages.
eq('a copy key exists for every failure code', Object.values(ERROR_CODES).filter((code) => !zhKeys.includes(`err.${code}`)), [])

// Every `t('literal')` call site names a key that exists.
const callSites = [...new Set([...client.matchAll(/\bt\(\s*'([a-zA-Z][a-zA-Z0-9_.]*)'/g)].map((match) => match[1]))]
const unresolvable = callSites.filter((key) => !zhKeys.includes(key))
eq('every literal key a component asks for exists', unresolvable, [])
check('  -> and the call-site scan actually found some', callSites.length > 40, `${callSites.length} keys`)

// The plugin-manager page reads meta.* from the locale files without activating
// the plugin; those two keys must therefore also exist in the bundle, or the
// list and the panel would disagree about the plugin's name.
for (const [label, document, block] of [
  ['zh', localeZh, zhBlock[1]],
  ['en', localeEn, enBlock[1]],
]) {
  check(`locale/${label}.json has a meta.title`, typeof document.meta?.title === 'string' && document.meta.title !== '')
  check(`locale/${label}.json has a meta.description`, typeof document.meta?.description === 'string' && document.meta.description !== '')
  check(`the inline ${label} dictionary repeats meta.title`, block.includes(`'meta.title': '${document.meta.title}'`))
  check(`the inline ${label} dictionary repeats meta.description`, block.includes(`'meta.description': '${document.meta.description}'`))
  check(`locale/${label}.json carries nothing beyond meta`, Object.keys(document).join(',') === 'meta')
}
check('the two locale files do not share a title', localeZh.meta.title !== localeEn.meta.title)

// ------------------------------------------- 9. the repo's own furniture

section('9. the repository carries what a published plugin is expected to')

for (const relativePath of [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'LICENSE',
  'icon.svg',
  '.gitignore',
  '.gitattributes',
  '.github/workflows/publish.yml',
  'docs/CONTRACT.md',
]) {
  check(`${relativePath} exists`, exists(relativePath))
}

check('LICENSE is MIT with the right holder', read('LICENSE').includes('MIT License') && read('LICENSE').includes('Copyright (c) 2026 Ckarefulon'))
check('.gitattributes normalizes to LF, which the bundle needs to stay byte-stable', /\* text=auto eol=lf/.test(read('.gitattributes')))
check('.gitignore does not exclude the hand-written bundle', !/^\s*lib\//m.test(read('.gitignore')))
check('.gitignore excludes the unit-test scratch directory', /test\/\.scratch\//.test(read('.gitignore')))

// Every piece of artwork is rendered by something. A glyph that is defined and
// never placed is the kind of thing that survives a refactor invisibly: it costs
// bytes in a hand-written bundle, and its presence suggests an icon that some
// screen is missing. Counting occurrences by name is enough here because these
// are local `const`s with distinctive names.
{
  const art = []
  for (const match of client.matchAll(/^ {4}const (\w+Glyph) = /gm)) {
    const name = match[1]
    const occurrences = client.split(name).length - 1
    // One occurrence is the declaration itself.
    if (occurrences < 2) art.push(name)
  }
  eq('every glyph is rendered somewhere', art, [])
}

for (const [label, text] of [
  ['README.md', readme],
  ['README.en.md', readmeEn],
]) {
  check(`${label} shows the install command with the real package name`, text.includes(`dsh plugin --profile`) && text.includes(manifest.name))
  check(`${label} links to the other language`, text.includes('README.en.md') || text.includes('README.md'))
  check(`${label} documents the configuration keys`, Object.keys(defaults).every((key) => text.includes(key)))
}

const workflow = read('.github/workflows/publish.yml')
const workflowCode = stripYamlComments(workflow)
check('the workflow publishes on a push to main', /push:\s*\n\s*branches:\s*\[main\]/.test(workflowCode))
check('the workflow grants id-token, which Trusted Publishing needs', /id-token:\s*write/.test(workflowCode))
check('the workflow carries no token secret', !/NPM_TOKEN|NODE_AUTH_TOKEN/.test(workflowCode))
check('  -> and the comment explaining why is still there', /NODE_AUTH_TOKEN/.test(workflow))
check('the workflow does not use setup-node registry-url, which would send a placeholder token', !/registry-url/.test(workflowCode))
check('the workflow upgrades npm past the version that cannot do OIDC', /npm@\^11/.test(workflowCode))
check('the workflow refuses to publish an already-published version', /npm view/.test(workflowCode))
check('the workflow runs the suite before publishing', /run:\s*npm test/.test(workflowCode))

section('10. nothing committed looks like a credential')
{
  const suspicious = []
  for (const each of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'README.en.md', 'docs/CONTRACT.md', '.github/workflows/publish.yml']) {
    const text = read(each)
    // A long opaque run next to the word token/secret/key is the shape that
    // matters; the words themselves are everywhere in prose.
    if (/(token|secret|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{16,}['"]/i.test(text)) suspicious.push(each)
    if (/gh[pousr]_[A-Za-z0-9]{20,}/.test(text)) suspicious.push(each)
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) suspicious.push(each)
  }
  eq('no file carries a literal credential', [...new Set(suspicious)], [])
}

// ------------------------------------------------------------------ wrap-up

console.log('')
if (failures > 0) {
  console.log(`${checks} checks, ${failures} failures`)
  process.exit(1)
}
console.log(`${checks} checks, all good`)
console.log(`checked ${relative(root, root) === '' ? '.' : root}`)
