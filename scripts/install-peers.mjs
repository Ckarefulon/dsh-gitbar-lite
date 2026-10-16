#!/usr/bin/env node
/**
 * Make the host half's peer dependencies importable from this repository.
 *
 * `lib/index.js` imports `@deepseek-ai/schemastery`, exactly as a published DSH
 * plugin does — DSH supplies it at runtime, and this repository deliberately does
 * not vendor it. That also means a bare checkout cannot `import` the plugin until
 * the peer is somewhere on the resolution path, and `npm test` would fail with
 * ERR_MODULE_NOT_FOUND for a reason that has nothing to do with the code.
 *
 * So: find an installed copy and copy it — and its dependency closure, because
 * `schemastery` itself imports `@deepseek-ai/cosmokit` — into `node_modules/`.
 * A copy rather than a link on purpose: creating a directory junction is blocked
 * by the hosted file sandbox, and copying behaves identically for a read-only
 * peer.
 *
 * Lookup order:
 *   1. anything already resolvable from this repository (do nothing);
 *   2. the `@deepseek-ai` scope of each installed DSH profile under DSH_HOME;
 *   3. `npm install --no-save` for whatever is still missing (what CI does).
 *
 * @module dsh-gitbar-lite/scripts/install-peers
 */

import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))

/** Peers the plugin imports at runtime, with the range it accepts. */
const PEERS = [{ name: '@deepseek-ai/schemastery', range: '>=3.18.0 <4' }]

/** `true` when `specifier` already resolves from this repository. */
function alreadyResolvable(specifier) {
  try {
    require.resolve(`${specifier}/package.json`)
    return true
  } catch {
    return false
  }
}

/** DSH home, matching `@deepseek-ai/dsh-home-paths`. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** Every `<DSH_HOME>/profiles/<name>/node_modules/@deepseek-ai` that exists. */
async function profileScopes() {
  let names
  try {
    names = await readdir(join(dshHome(), 'profiles'))
  } catch {
    return []
  }
  const scopes = []
  for (const name of names) {
    const scope = join(join(dshHome(), 'profiles'), name, 'node_modules', '@deepseek-ai')
    try {
      if ((await stat(scope)).isDirectory()) scopes.push(scope)
    } catch {
      // Not an installed profile.
    }
  }
  return scopes
}

/** The directory a package would be copied from, if the profiles have it. */
async function findSource(scopes, name) {
  const leaf = name.replace(/^@[^/]+\//, '')
  for (const scope of scopes) {
    const candidate = join(scope, leaf)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Try the next scope.
    }
  }
  return undefined
}

/**
 * Walk `roots` plus their declared `dependencies` breadth-first, keeping the
 * first source directory found for each package.
 *
 * @returns {Promise<Map<string, string>>} package name → source directory
 */
async function closure(scopes, roots) {
  const found = new Map()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.shift()
    if (found.has(name)) continue
    const source = await findSource(scopes, name)
    if (source === undefined) continue
    found.set(name, source)
    try {
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push(dependency)
    } catch {
      // A package without a readable manifest still gets copied; it just
      // contributes no further dependencies.
    }
  }
  return found
}

/** Copy a package directory into `node_modules/<name>`. */
async function copyInto(name, source) {
  const destination = join(root, 'node_modules', ...name.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
}

/** Fall back to npm, which is what a CI runner does. */
function npmInstall(names) {
  return new Promise((resolvePromise) => {
    const child = spawn('npm', ['install', '--no-save', '--no-package-lock', ...names], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.on('close', (code) => resolvePromise(code === 0))
    child.on('error', () => resolvePromise(false))
  })
}

/**
 * Copy, or install, every peer the host half needs.
 *
 * @param {{ quiet?: boolean }} [options]
 * @returns {Promise<boolean>} whether everything is importable afterwards
 */
export async function installPeers({ quiet = false } = {}) {
  const log = (message) => {
    if (!quiet) console.log(message)
  }

  const wanted = PEERS.filter((peer) => !alreadyResolvable(peer.name))
  for (const peer of PEERS) {
    if (!wanted.includes(peer)) log(`  ${peer.name}: already resolvable`)
  }
  if (wanted.length === 0) return true

  const scopes = await profileScopes()
  const packages = await closure(
    scopes,
    wanted.map((peer) => peer.name),
  )

  const missing = []
  for (const peer of wanted) {
    if (!packages.has(peer.name)) missing.push(peer)
  }

  // Copy dependencies first so a partially-copied closure is never left where
  // Node would resolve the root but not its dependency.
  const names = [...packages.keys()]
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index]
    await copyInto(name, packages.get(name))
    log(`  ${name}: copied from ${packages.get(name)}`)
  }

  if (missing.length > 0) {
    log(`  not found in any installed profile: ${missing.map((peer) => peer.name).join(', ')}; asking npm`)
    if (!(await npmInstall(missing.map((peer) => `${peer.name}@${peer.range}`)))) {
      console.error(`cannot obtain peer dependencies: ${missing.map((peer) => peer.name).join(', ')}`)
      console.error('Install them, or point DSH_HOME at an installation that has them.')
      return false
    }
  }

  for (const peer of PEERS) {
    if (!alreadyResolvable(peer.name)) {
      console.error(`still not resolvable after install: ${peer.name}`)
      return false
    }
  }
  return true
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log('dsh-gitbar-lite: preparing peer dependencies')
  process.exit((await installPeers()) ? 0 : 1)
}
