#!/usr/bin/env node
/**
 * The live probe: is this plugin actually mounted in a running DSH, answering
 * behind the harness's own security fence?
 *
 * This is deliberately not a behavioural test. The suite's behaviour coverage
 * comes from `test/e2e.mjs` (real git, real handlers) and the unit tests; what
 * neither of them can show is that the published bytes load in a real Host, that
 * the route is registered on the real `connection.fetch`, and that the request
 * path the browser half uses is the path the host actually serves.
 *
 * The probe POSTs a read-only action and reads the *status* as the signal.
 * Reading it correctly matters, because the obvious reading is wrong: the `/api`
 * prefix route runs `admit()` — the Host/Origin fence and the cookie check —
 * **before** it dispatches to any registered route, so an unauthenticated request
 * to a path nobody serves also returns 401. A 401 therefore proves the fence
 * works and proves nothing about whether this plugin is mounted.
 *
 *   200 + { ok: true }   the plugin is live. Done.
 *   404                  authenticated, and no route serves this path: the
 *                        profile does not have the plugin. (An unauthenticated
 *                        request can never get this far, so a 404 is proof.)
 *   401                  the fence answered. This is a DSH `/api` surface, but
 *                        whether the plugin is mounted is not observable from
 *                        here. INCONCLUSIVE, and it says so.
 *   403                  the Host header is not trusted. Either this is not DSH,
 *                        or it is reached through a proxy whose authority is not
 *                        in `connection.trustedHosts`.
 *   connection refused   nothing is running. SKIP, exit 0.
 *
 * For a definitive answer, authenticate: open DSH in a browser first (the visit
 * seeds the cookie), or pass `DSH_AUTH_TOKEN` with the launch token `dsh web`
 * printed.
 *
 * Configure with `DSH_WEB_URL` (default `http://127.0.0.1:19387`).
 *
 * Exits 0 for a pass, a skip, and an inconclusive result; 1 for a finding that
 * needs attention. Run directly (`node test/live.mjs`); it is not part of
 * `npm test`, because it depends on a running application.
 *
 * @module dsh-lite-git/test/live
 */

import { RPC_ROUTE } from '../lib/shared.js'

const base = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')
const token = process.env.DSH_AUTH_TOKEN
const url = `${base}${RPC_ROUTE}${token === undefined || token === '' ? '' : `?token=${encodeURIComponent(token)}`}`

console.log(`dsh-lite-git: probing ${url}`)

let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'prefs' }),
  })
} catch (error) {
  console.log(`  SKIP: nothing answered (${String(error?.cause?.code ?? error?.message ?? error)})`)
  console.log('  Start DSH (`dsh web`) and install this plugin, or point DSH_WEB_URL at one that has it.')
  process.exit(0)
}

const text = await response.text()

if (response.status === 200) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    console.log(`  FAIL: 200 with a body that is not JSON: ${text.slice(0, 160)}`)
    process.exit(1)
  }
  if (body?.ok !== true || typeof body?.prefs?.trashHardDelete !== 'boolean') {
    console.log(`  FAIL: 200 but not the shape this plugin answers with: ${JSON.stringify(body).slice(0, 200)}`)
    process.exit(1)
  }
  console.log(`  ok: the plugin answered a real request through the real fence (${JSON.stringify(body.prefs)})`)
  process.exit(0)
}

if (response.status === 401) {
  console.log('  INCONCLUSIVE: the fence answered (401), so this is a DSH /api surface.')
  console.log('  But the fence runs before route dispatch, so an unauthenticated request to a')
  console.log('  path nobody serves answers 401 too -- this does not show the plugin is mounted.')
  console.log('  For a definitive answer: open DSH in a browser first (that visit seeds the cookie),')
  console.log('  or re-run with DSH_AUTH_TOKEN=<the token `dsh web` printed>.')
  process.exit(0)
}

if (response.status === 403) {
  console.log(`  WARN: the Host header was not trusted (403). Body: ${text.slice(0, 120)}`)
  console.log('  Either this is not DSH, or you are reaching it through a proxy whose authority is not in trustedHosts.')
  process.exit(0)
}

if (response.status === 404) {
  // Reaching 404 means the fence and the cookie check both passed, so this is a
  // definite answer rather than a guess.
  console.log(`  FAIL: authenticated, but nothing serves ${RPC_ROUTE} at ${base}`)
  console.log('  That profile does not have dsh-lite-git installed (or the plugin failed to load).')
  process.exit(1)
}

console.log(`  FAIL: unexpected status ${response.status}: ${text.slice(0, 200)}`)
process.exit(1)
