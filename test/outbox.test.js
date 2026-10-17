import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createOutbox,
  memoryStore,
  fileStore,
  parseOutbox,
  createUndoServer,
  undoToken,
  verifyUndoToken,
  newSecret,
  UndoSendError,
} from '../src/index.js'
import { formatList, formatEntry } from '../src/report.js'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))
const SECRET = 'test-secret-0123456789-abcdefghijklmnop'
const BASE = 'https://undo.example.com'
const T0 = Date.parse('2026-10-16T14:00:00Z')
const tmp = () => mkdtempSync(join(tmpdir(), 'undo-send-'))

/** A clock the test moves by hand. */
function fakeClock(start = T0) {
  let t = start
  const now = () => t
  now.advance = (/** @type {number} */ ms) => {
    t += ms
  }
  return now
}

/**
 * @param {import('../src/index.js').Store} [store]
 */
function setup(store = memoryStore()) {
  const now = fakeClock()
  /** @type {unknown[]} */
  const sent = []
  const outbox = createOutbox(store, { delay: '2m', secret: SECRET, baseUrl: BASE, now })
  outbox.register('email', (payload) => {
    sent.push(payload)
    return { messageId: `m${sent.length}` }
  })
  return { outbox, now, sent, store }
}

test('holds an action, then runs it once it is due', async () => {
  const { outbox, now, sent } = setup()
  const held = await outbox.hold('email', { to: 'dana@acme.com' }, { summary: 'Email to dana@acme.com' })
  assert.equal(held.outcome, 'held')
  assert.match(held.id, /^u_/)
  assert.equal(held.dueAt, '2026-10-16T14:02:00.000Z')
  assert.equal(held.undoUrl, `${BASE}/undo/${held.id}?t=${undoToken(SECRET, held.id)}`)

  assert.deepEqual(await outbox.run(), [])
  now.advance(119_999)
  assert.deepEqual(await outbox.run(), [])
  assert.equal(sent.length, 0)

  now.advance(1)
  const [r] = await outbox.run()
  assert.equal(r.outcome, 'sent')
  assert.deepEqual(sent, [{ to: 'dana@acme.com' }])
  const entry = await outbox.get(held.id)
  assert.equal(entry?.status, 'sent')
  assert.deepEqual(entry?.result, { messageId: 'm1' })
  assert.equal(entry?.finishedAt, '2026-10-16T14:02:00.000Z')

  assert.deepEqual(await outbox.run(), [], 'never runs twice')
  assert.equal(sent.length, 1)
})

test('an undone action never runs', async () => {
  const { outbox, now, sent } = setup()
  const { id } = await outbox.hold('email', { to: 'dana@acme.com' })
  const r = await outbox.cancel(id, { by: 'sam', reason: 'wrong customer' })
  assert.equal(r.outcome, 'cancelled')
  assert.equal(r.entry?.cancelledBy, 'sam')
  assert.equal(r.entry?.reason, 'wrong customer')
  assert.equal((await outbox.cancel(id)).outcome, 'already_cancelled')
  now.advance(10 * 60_000)
  assert.deepEqual(await outbox.run(), [])
  assert.equal(sent.length, 0)
})

test('too late to undo once it has run', async () => {
  const { outbox, now } = setup()
  const { id } = await outbox.hold('email', {})
  now.advance(120_000)
  await outbox.run()
  const r = await outbox.cancel(id)
  assert.equal(r.outcome, 'too_late')
  assert.equal(r.entry?.status, 'sent')
  assert.equal((await outbox.cancel('nope')).outcome, 'not_found')
})

test('holding the same id twice holds it once', async () => {
  const { outbox, now, sent } = setup()
  const a = await outbox.hold('email', { n: 1 }, { id: 'order-42-confirmation' })
  now.advance(30_000)
  const b = await outbox.hold('email', { n: 2 }, { id: 'order-42-confirmation' })
  assert.equal(a.outcome, 'held')
  assert.equal(b.outcome, 'duplicate')
  assert.equal(b.dueAt, a.dueAt)
  assert.deepEqual(b.entry.payload, { n: 1 })
  now.advance(120_000)
  await outbox.run()
  assert.deepEqual(sent, [{ n: 1 }])
  const after = await outbox.hold('email', { n: 3 }, { id: 'order-42-confirmation' })
  assert.equal(after.outcome, 'duplicate')
  assert.equal(after.undoUrl, null, 'no undo link for something already sent')
})

test('a delay per action, and send now', async () => {
  const { outbox, now, sent } = setup()
  const slow = await outbox.hold('email', { n: 'slow' }, { delay: '1h' })
  const fast = await outbox.hold('email', { n: 'fast' }, { delay: 0 })
  assert.deepEqual((await outbox.run()).map((r) => r.id), [fast.id])
  assert.equal((await outbox.sendNow(slow.id)).outcome, 'released')
  assert.deepEqual((await outbox.run()).map((r) => r.id), [slow.id])
  assert.deepEqual(sent, [{ n: 'fast' }, { n: 'slow' }])
  assert.equal((await outbox.sendNow(slow.id)).outcome, 'too_late')
  now.advance(1)
})

test('runs due actions oldest first, and respects a limit', async () => {
  const { outbox, now } = setup()
  const a = await outbox.hold('email', {}, { delay: '3m' })
  const b = await outbox.hold('email', {}, { delay: '1m' })
  const c = await outbox.hold('email', {}, { delay: '2m' })
  now.advance(5 * 60_000)
  assert.deepEqual((await outbox.run({ limit: 2 })).map((r) => r.id), [b.id, c.id])
  assert.deepEqual((await outbox.run()).map((r) => r.id), [a.id])
})

test('an executor that throws marks the action failed, and it is not retried', async () => {
  const { outbox, now } = setup()
  let calls = 0
  outbox.register('sms', () => {
    calls++
    throw new Error('Carrier rejected: unregistered sender')
  })
  const { id } = await outbox.hold('sms', { to: '+15550100' })
  now.advance(120_000)
  const [r] = await outbox.run()
  assert.equal(r.outcome, 'failed')
  assert.equal(r.entry?.error, 'Carrier rejected: unregistered sender')
  now.advance(120_000)
  assert.deepEqual(await outbox.run(), [])
  assert.equal(calls, 1)
  assert.equal((await outbox.get(id))?.status, 'failed')
})

test('an action with no executor here stays held', async () => {
  const { outbox, now } = setup()
  const { id } = await outbox.hold('refund', { amount: 40 })
  now.advance(120_000)
  const [r] = await outbox.run()
  assert.equal(r.outcome, 'no_executor')
  assert.equal((await outbox.get(id))?.status, 'held')
  assert.equal((await outbox.cancel(id)).outcome, 'cancelled')
})

test('a crash mid-send leaves it executing; it is never retried, only resolved', async () => {
  const dir = tmp()
  const path = join(dir, 'outbox.jsonl')
  const now = fakeClock()
  const first = createOutbox(fileStore(path), { now })
  first.register('email', () => new Promise(() => {})) // never returns, as if the process died
  const { id } = await first.hold('email', { to: 'dana@acme.com' })
  now.advance(120_000)
  void first.run()
  await new Promise((r) => setTimeout(r, 50))

  // A new process starts on the same file.
  let calls = 0
  const second = createOutbox(fileStore(path), { now })
  second.register('email', () => {
    calls++
  })
  assert.equal((await second.get(id))?.status, 'executing')
  now.advance(10 * 60_000)
  assert.deepEqual(await second.run(), [])
  assert.equal(calls, 0)
  assert.equal((await second.cancel(id)).outcome, 'too_late')

  const r = await second.resolve(id, 'sent', { by: 'sam', note: 'In the Postmark activity log' })
  assert.equal(r.outcome, 'resolved')
  assert.equal(r.entry?.resolvedBy, 'sam')
  assert.equal((await second.resolve(id, 'failed')).outcome, 'not_executing')
  assert.equal((await second.resolve('nope', 'failed')).outcome, 'not_found')
})

test('undo and run racing from two processes: exactly one wins, every time', async () => {
  const path = join(tmp(), 'outbox.jsonl')
  const now = fakeClock()
  /** @type {string[]} */
  const ran = []
  const runner = createOutbox(fileStore(path), { now })
  runner.register('email', (p) => {
    ran.push(p.id)
  })
  const person = createOutbox(fileStore(path), { now })
  const ids = []
  for (let i = 0; i < 20; i++) ids.push((await runner.hold('email', { id: `x${i}` }, { id: `x${i}` })).id)
  now.advance(120_000)

  const [, cancels] = await Promise.all([runner.run(), Promise.all(ids.map((id) => person.cancel(id)))])
  const states = await Promise.all(ids.map((id) => runner.get(id)))
  for (let i = 0; i < ids.length; i++) {
    const s = states[i]?.status
    if (cancels[i].outcome === 'cancelled') {
      assert.equal(s, 'cancelled')
      assert.ok(!ran.includes(`x${i}`), `x${i} was undone and also ran`)
    } else {
      assert.equal(cancels[i].outcome, 'too_late')
      assert.equal(s, 'sent')
      assert.ok(ran.includes(`x${i}`))
    }
  }
  assert.equal(new Set(ran).size, ran.length, 'nothing ran twice')
})

test('two runners on one file never run an action twice', async () => {
  const path = join(tmp(), 'outbox.jsonl')
  const now = fakeClock()
  /** @type {string[]} */
  const ran = []
  const make = () => createOutbox(fileStore(path), { now }).register('email', (p) => void ran.push(p.n))
  const a = make()
  const b = make()
  for (let n = 0; n < 15; n++) await a.hold('email', { n })
  now.advance(120_000)
  const [ra, rb] = await Promise.all([a.run(), b.run()])
  assert.equal(ran.length, 15)
  assert.equal(new Set(ran).size, 15)
  assert.equal(ra.filter((r) => r.outcome === 'sent').length + rb.filter((r) => r.outcome === 'sent').length, 15)
})

test('the file keeps every state, and the last line per id wins', async () => {
  const path = join(tmp(), 'outbox.jsonl')
  const now = fakeClock()
  const outbox = createOutbox(fileStore(path), { now }).register('email', () => 'ok')
  const { id } = await outbox.hold('email', { when: new Date(T0) })
  now.advance(120_000)
  await outbox.run()
  const text = readFileSync(path, 'utf8')
  assert.deepEqual(text.trim().split('\n').map((l) => JSON.parse(l).status), ['held', 'executing', 'sent'])
  const { entries, skipped } = parseOutbox(`${text}{"torn":`)
  assert.equal(skipped, 1)
  assert.equal(entries.get(id)?.status, 'sent')
  assert.deepEqual(entries.get(id)?.payload, { when: '2026-10-16T14:00:00.000Z' })
})

test('the runner runs on a timer and stops cleanly', async () => {
  const realClock = createOutbox(memoryStore(), { delay: 0 })
  /** @type {unknown[]} */
  const got = []
  realClock.register('email', (p) => void got.push(p))
  await realClock.hold('email', { a: 1 })
  const runner = realClock.start({ every: '10ms' })
  await new Promise((r) => setTimeout(r, 60))
  await realClock.hold('email', { a: 2 })
  await new Promise((r) => setTimeout(r, 60))
  await runner.stop()
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }])
})

test('undo tokens', () => {
  const t = undoToken(SECRET, 'u_1')
  assert.equal(t.length, 43)
  assert.ok(verifyUndoToken(SECRET, 'u_1', t))
  assert.ok(!verifyUndoToken(SECRET, 'u_2', t))
  assert.ok(!verifyUndoToken(`${SECRET}x`, 'u_1', t))
  assert.ok(!verifyUndoToken(SECRET, 'u_1', t.slice(1)))
  assert.ok(!verifyUndoToken(SECRET, 'u_1', null))
  assert.ok(newSecret().length >= 32)
})

test('options are checked', async () => {
  assert.throws(() => createOutbox(memoryStore(), { secret: 'short' }), UndoSendError)
  assert.throws(() => createOutbox(memoryStore(), { baseUrl: 'undo.example.com' }), UndoSendError)
  assert.throws(() => createOutbox(memoryStore(), { delay: '2 minutes' }), TypeError)
  assert.throws(() => createOutbox(/** @type {any} */ ({})), UndoSendError)
  const o = createOutbox(memoryStore())
  await assert.rejects(o.hold('email', {}, { id: 'has space' }), UndoSendError)
  await assert.rejects(o.hold('email', { n: 1n }), UndoSendError)
  const { undoUrl } = await o.hold('email', {})
  assert.equal(undoUrl, null, 'no link without a secret and base URL')
})

// ---------------------------------------------------------------------------------------
// Undo page
// ---------------------------------------------------------------------------------------

/**
 * @param {import('../src/index.js').Outbox} outbox
 * @returns {Promise<{ base: string, close: () => Promise<void> }>}
 */
async function listen(outbox) {
  const server = createUndoServer(outbox)
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  }
}

test('opening an undo link changes nothing; the button undoes it', async () => {
  const { outbox, sent, now } = setup()
  const { id } = await outbox.hold('email', {}, { summary: 'Email to <dana@acme.com>: "Your quote"' })
  const { base, close } = await listen(outbox)
  try {
    const path = `/undo/${id}?t=${undoToken(SECRET, id)}`
    const get = await fetch(base + path)
    const html = await get.text()
    assert.equal(get.status, 200)
    assert.equal(get.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(get.headers.get('cache-control'), 'no-store')
    assert.match(get.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
    assert.match(html, /Undo this\?/)
    assert.match(html, /Email to &lt;dana@acme\.com&gt;: &quot;Your quote&quot;/)
    assert.match(html, /in 2m 0s, at 14:02:00 UTC, 16 Oct 2026/)
    assert.equal((await outbox.get(id))?.status, 'held', 'a GET must not undo')

    const post = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `t=${undoToken(SECRET, id)}`,
    })
    assert.equal(post.status, 200)
    assert.match(await post.text(), /Undone\. It will not go\./)
    const entry = await outbox.get(id)
    assert.equal(entry?.status, 'cancelled')
    assert.equal(entry?.cancelledBy, 'undo link')

    assert.match(await (await fetch(base + path)).text(), /Already undone/)
    now.advance(120_000)
    await outbox.run()
    assert.equal(sent.length, 0)
  } finally {
    await close()
  }
})

test('a bad token, an unknown id, or a link after it ran', async () => {
  const { outbox, now } = setup()
  const { id } = await outbox.hold('email', {})
  const other = await outbox.hold('email', {})
  const { base, close } = await listen(outbox)
  try {
    assert.equal((await fetch(`${base}/undo/${id}?t=${undoToken(SECRET, other.id)}`)).status, 404)
    assert.equal((await fetch(`${base}/undo/${id}`)).status, 404)
    assert.equal((await fetch(`${base}/undo/nope?t=${undoToken(SECRET, 'nope')}`)).status, 404)
    const wrong = await fetch(`${base}/undo/${id}`, { method: 'POST', body: 't=wrong' })
    assert.equal(wrong.status, 404)
    assert.equal((await outbox.get(id))?.status, 'held')
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404)
    assert.equal((await fetch(`${base}/health`)).status, 200)
    assert.equal((await fetch(`${base}/undo/${id}`, { method: 'DELETE' })).status, 405)

    now.advance(120_000)
    await outbox.run()
    const t = undoToken(SECRET, id)
    assert.match(await (await fetch(`${base}/undo/${id}?t=${t}`)).text(), /Too late: it has gone\./)
    const late = await fetch(`${base}/undo/${id}`, { method: 'POST', body: `t=${t}` })
    assert.equal(late.status, 409)
  } finally {
    await close()
  }
})

test('works behind a path prefix', async () => {
  const { outbox } = setup()
  const { id } = await outbox.hold('email', {})
  const { base, close } = await listen(outbox)
  try {
    const res = await fetch(`${base}/hooks/undo/${id}?t=${undoToken(SECRET, id)}`)
    assert.equal(res.status, 200)
  } finally {
    await close()
  }
})

// ---------------------------------------------------------------------------------------
// Report and CLI
// ---------------------------------------------------------------------------------------

test('list and show text', async () => {
  const { outbox, now } = setup()
  await outbox.hold('email', {}, { id: 'a1', summary: 'Email to dana@acme.com' })
  await outbox.hold('email', {}, { id: 'b2', delay: 0 })
  await outbox.run()
  const text = formatList(await outbox.list(), { now: now() })
  assert.match(text, /^sent {7}b2 {2}sent just now/m)
  assert.match(text, /^held {7}a1 {2}due in 2m {6}email {2}Email to dana@acme\.com$/m)
  assert.match(text, /1 held/)
  assert.equal(formatList([], { now: 0 }), 'Nothing in the outbox.\n')
  const show = formatEntry(/** @type {any} */ (await outbox.get('a1')), { now: now() })
  assert.match(show, /^summary {2}Email to dana@acme\.com$/m)
  const stuck = formatEntry({ ...(/** @type {any} */ (await outbox.get('a1'))), status: 'executing' }, { now: now() })
  assert.match(stuck, /undo-send resolve a1 sent/)
})

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } })
}

test('cli: list, show, cancel, send-now, resolve and exit codes', async () => {
  const path = join(tmp(), 'outbox.jsonl')
  const outbox = createOutbox(fileStore(path), { delay: '1h' })
  await outbox.hold('email', { to: 'dana@acme.com' }, { id: 'q1', summary: 'Email to dana@acme.com' })
  await outbox.hold('email', {}, { id: 'q2' })
  const env = { UNDO_SEND_OUTBOX: path }

  let r = cli(['list'], env)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /held {7}q1/)
  r = cli(['list', '--status', 'held', '--json'], env)
  assert.deepEqual(JSON.parse(r.stdout).map((/** @type {any} */ e) => e.key), ['q1', 'q2'])
  assert.equal(cli(['list', '--status', 'nope'], env).status, 2)

  r = cli(['show', 'q1'], env)
  assert.match(r.stdout, /dana@acme\.com/)
  assert.equal(cli(['show', 'zz'], env).status, 1)

  r = cli(['cancel', 'q1', '--reason', 'wrong customer', '--by', 'sam'], env)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Undone: q1/)
  assert.equal((await outbox.get('q1'))?.cancelledBy, 'sam')
  assert.equal(cli(['cancel', 'q1'], env).status, 0)
  assert.equal(cli(['send-now', 'q1'], env).status, 1)

  assert.equal(cli(['send-now', 'q2'], env).status, 0)
  outbox.register('email', () => {})
  await outbox.run()
  r = cli(['cancel', 'q2'], env)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /Too late: q2 is sent/)
  assert.equal(cli(['resolve', 'q2', 'sent'], env).status, 1)
  assert.equal(cli(['resolve', 'q2', 'maybe'], env).status, 2)

  assert.equal(cli(['list']).status, 2, 'needs an outbox')
  assert.equal(cli(['frobnicate'], env).status, 2)
  assert.equal(cli(['serve'], { ...env, UNDO_SEND_SECRET: 'short' }).status, 2)
  assert.ok(cli(['secret']).stdout.trim().length >= 32)
})
