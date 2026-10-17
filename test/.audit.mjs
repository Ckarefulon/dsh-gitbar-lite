import { readFileSync } from 'node:fs'

const src = readFileSync('lib/client.js', 'utf8')

// Glyph components that are defined but never rendered.
const defs = [...src.matchAll(/const (\w+Glyph) = (?:filled)?artwork\(/g)].map((m) => m[1])
for (const name of defs) {
  const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
  if (uses < 2) console.log('UNUSED GLYPH:', name)
}

// Keys used through t('...') against the zh table.
const zhStart = src.indexOf('const ZH')
const enStart = src.indexOf('const EN')
const zh = src.slice(zhStart, enStart)
const used = new Set([...src.matchAll(/t\('([a-zA-Z][\w.]+)'/g)].map((m) => m[1]))
const defined = new Set([...zh.matchAll(/'([a-z][\w.]+)':/g)].map((m) => m[1]))

const missing = [...used].filter((key) => !defined.has(key))
console.log('MISSING (used, not defined):', missing.length === 0 ? '(none)' : missing.join(', '))

const unused = [...defined].filter((key) => !used.has(key) && !src.includes(`'${key}'`))
console.log('DEFINED BUT NEVER USED:', unused.length === 0 ? '(none)' : unused.join(', '))

// Dynamic keys built as `status.${kind}` / `err.${code}` must all exist.
for (const prefix of ['status']) {
  for (const kind of ['added', 'modified', 'deleted', 'renamed', 'conflicted']) {
    if (!defined.has(`${prefix}.${kind}`)) console.log(`MISSING dynamic key: ${prefix}.${kind}`)
  }
}

// Host-side: exported symbols that nothing imports.
const shared = readFileSync('lib/shared.js', 'utf8')
for (const name of [...shared.matchAll(/^  ([A-Z_]+):/gm)].map((m) => m[1])) {
  // checked per-object below, not here
}
