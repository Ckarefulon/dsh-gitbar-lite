#!/usr/bin/env node
/**
 * Reproduce — offline, without restarting DSH — the check the module loader
 * performs when it composes a client plugin.
 *
 * `dsh-client-modules` resolves `exports["./client"]` as an *exact file path*:
 * no extension completion, no directory index fallback. A manifest that names a
 * file the build did not produce does not degrade to "this plugin is missing";
 * it raises `MissingClientBundleError` and **aborts the whole Host boot**. That
 * failure is worth catching before a restart, which is the only reason this
 * script exists.
 *
 * Beyond the path check it catches the four ways a bundle can load and still be
 * broken: a missing `dsh.bundle.patch` target, `module.exports` used without
 * declaring `module`, a bundle that never returns its exports, and a bundle that
 * does not register the id the graph keys on (the last one *also* aborts boot,
 * with `loaded without registering "<id>" via __ModuleLoader__.load`).
 *
 * Usage: node scripts/check-client-bundle.mjs <packageRoot>
 *
 * @module dsh-gitbar-lite/scripts/check-client-bundle
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const argument = process.argv[2]
if (argument === undefined) {
  console.error('usage: node scripts/check-client-bundle.mjs <packageRoot>')
  process.exit(2)
}

const packageRoot = resolve(argument)
const packagePath = join(packageRoot, 'package.json')

let pkg
try {
  pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
} catch (error) {
  console.log(`  cannot read ${packagePath}: ${error.message}`)
  process.exit(1)
}

console.log(`dsh-gitbar-lite: checking the client bundle of ${pkg.name}`)

// --- parseDshClient(): without a dsh.client row, this package is not in the graph.
const declaration = pkg.dsh?.client
if (declaration === undefined) {
  console.log('  no dsh.client declaration, so client-modules skips this package')
  process.exit(0)
}
if (typeof declaration.platform !== 'string') {
  console.log('  FAIL: dsh.client.platform must be a string')
  process.exit(1)
}
if (declaration.platform !== 'web') {
  console.log(`  platform is "${declaration.platform}", not "web", so nothing loads in the browser`)
  process.exit(0)
}
if (declaration.inject !== undefined) {
  const ok = Array.isArray(declaration.inject) && declaration.inject.every((name) => typeof name === 'string')
  if (!ok) {
    // A malformed list throws during composition, which also aborts boot.
    console.log('  FAIL: dsh.client.inject must be a string array')
    process.exit(1)
  }
}

// --- clientExportOf(): a string, or an object with a string `default`.
const clientExport = pkg.exports?.['./client']
if (clientExport === undefined) {
  console.log('  FAIL: the package declares dsh.client but exports no "./client"')
  process.exit(1)
}
const relative = typeof clientExport === 'string' ? clientExport : clientExport?.default
if (typeof relative !== 'string') {
  console.log('  FAIL: exports["./client"] must be a string or { default: string }')
  process.exit(1)
}

// --- The one line that aborts the boot: join, then stat. Nothing else.
const clientPath = join(dirname(packagePath), relative)
const stats = statSync(clientPath, { throwIfNoEntry: false })
if (stats?.isFile() !== true) {
  console.log('  RESULT: MissingClientBundleError — DSH would abort startup')
  console.log(`  declared: ${relative}`)
  console.log(`  resolved: ${clientPath}`)
  console.log('  Ship the exact file the manifest names.')
  process.exit(1)
}

const bundle = readFileSync(clientPath, 'utf8')
const patch = pkg.dsh?.bundle?.patch
const patchOk = typeof patch !== 'string' || existsSync(join(packageRoot, patch))

// The loader passes `require` but not `module`, so a bundle that uses
// `module.exports` has to declare the shim itself and return it.
const usesModuleExports = /module\.exports/.test(bundle)
const declaresModule = /(?:const|let|var)\s+module\s*=\s*\{\s*exports\s*:\s*\{\s*\}\s*\}/.test(bundle)
const returnsExports = /return module\.exports/.test(bundle)
const registersId = bundle.includes(`id: '${pkg.name}'`) || bundle.includes(`id: "${pkg.name}"`)

const problems = []
if (!patchOk) problems.push(`dsh.bundle.patch points at ${JSON.stringify(patch)}, which does not exist`)
if (usesModuleExports && !declaresModule) problems.push('the bundle uses module.exports but never declares `const module = { exports: {} }`')
if (usesModuleExports && !returnsExports) problems.push('the bundle does not `return module.exports`')
if (!registersId) problems.push(`the bundle does not register id ${JSON.stringify(pkg.name)}, so client-modules aborts the boot`)

if (problems.length > 0) {
  console.log('  RESULT: the bundle would load with problems')
  for (const problem of problems) console.log(`    - ${problem}`)
  process.exit(1)
}

console.log(`  bundle: ${relative} (${bundle.length} bytes)`)
console.log('  RESULT: client-modules composes this package without MissingClientBundleError')
