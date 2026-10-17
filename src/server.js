import { createServer } from 'node:http'
import { formatDuration } from './duration.js'

/**
 * @typedef {import('./outbox.js').Outbox} Outbox
 * @typedef {import('./outbox.js').Entry} Entry
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 */

const MAX_BODY = 2048

/** The link can be pasted anywhere, so the page must not leak it, be framed, or be cached. */
const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

/**
 * A request handler for undo links, `/undo/<id>?t=<token>`, mountable in any Node HTTP
 * server or framework that passes (req, res). Paths are matched on their end, so it works
 * behind a prefix such as /hooks/undo/<id>.
 *
 * Opening a link never undoes anything: link previews in Slack, Teams and mail clients
 * fetch every URL they see, and a GET that cancelled would be triggered by the preview.
 * The page says what will happen and when; only its button, a POST, undoes it.
 *
 * @param {Outbox} outbox Needs the same secret as the outbox that made the links.
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
export function createUndoHandler(outbox) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.endsWith('/health') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('ok\n')
      return
    }
    const match = /\/undo\/([^/]+)$/.exec(url.pathname)
    if (!match) return page(res, 404, notValid())

    let id
    try {
      id = decodeURIComponent(match[1])
    } catch {
      return page(res, 404, notValid())
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const token = url.searchParams.get('t')
      if (!outbox.checkUndoToken(id, token)) return page(res, 404, notValid())
      const entry = await outbox.get(id)
      if (!entry) return page(res, 404, notValid())
      return page(res, 200, describe(entry, outbox.now(), token ?? ''))
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch {
        return page(res, 413, { title: 'Too large', heading: 'That request was too large.', body: '' })
      }
      const token = new URLSearchParams(body).get('t') ?? url.searchParams.get('t')
      if (!outbox.checkUndoToken(id, token)) return page(res, 404, notValid())
      const result = await outbox.cancel(id, { by: 'undo link' })
      if (!result.entry) return page(res, 404, notValid())
      const status = result.outcome === 'too_late' ? 409 : 200
      return page(res, status, describe(result.entry, outbox.now(), token ?? '', result.outcome === 'cancelled'))
    }

    res.setHeader('Allow', 'GET, HEAD, POST')
    return page(res, 405, { title: 'Not allowed', heading: 'Open the link in a browser.', body: '' })
  }
}

/**
 * A standalone HTTP server for undo links. Call listen() on it.
 *
 * @param {Outbox} outbox
 */
export function createUndoServer(outbox) {
  const handle = createUndoHandler(outbox)
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      process.stderr.write(`undo-send: ${error?.stack ?? error}\n`)
      if (!res.headersSent) page(res, 500, { title: 'Error', heading: 'Something went wrong. Nothing was undone.', body: '' })
      else res.end()
    })
  })
}

/**
 * @typedef {object} Page
 * @property {string} title
 * @property {string} heading
 * @property {string} body HTML.
 * @property {'held'|'done'|'late'|'neutral'} [tone]
 */

/** @returns {Page} */
function notValid() {
  return {
    title: 'Link not valid',
    heading: 'This undo link is not valid.',
    body: '<p>It may have been copied incompletely. Nothing was changed.</p>',
  }
}

/**
 * @param {Entry} entry
 * @param {number} now
 * @param {string} token
 * @param {boolean} [justCancelled]
 * @returns {Page}
 */
function describe(entry, now, token, justCancelled = false) {
  const what = `<p class="what">${escape(entry.summary ?? `${entry.action} ${entry.key}`)}</p>`
  switch (entry.status) {
    case 'held': {
      const due = Date.parse(entry.dueAt)
      const when = due > now ? `in ${countdown(due - now)}, at ${clock(entry.dueAt)}` : 'any moment now'
      return {
        title: 'Undo this?',
        tone: 'held',
        heading: 'Undo this?',
        body:
          `${what}<p>It goes ${when}. Opening this page changed nothing.</p>` +
          `<form method="post" action=""><input type="hidden" name="t" value="${escape(token)}">` +
          `<button type="submit">Undo it</button></form>`,
      }
    }
    case 'cancelled':
      return {
        title: 'Undone',
        tone: 'done',
        heading: justCancelled ? 'Undone. It will not go.' : 'Already undone. It will not go.',
        body: `${what}<p>Undone at ${clock(/** @type {string} */ (entry.cancelledAt))}${entry.cancelledBy && !justCancelled ? ` by ${escape(entry.cancelledBy)}` : ''}.</p>`,
      }
    case 'executing':
      return {
        title: 'Too late',
        tone: 'late',
        heading: 'Too late: it is going now.',
        body: `${what}<p>It started at ${clock(/** @type {string} */ (entry.startedAt))} and can no longer be undone.</p>`,
      }
    case 'sent':
      return {
        title: 'Too late',
        tone: 'late',
        heading: 'Too late: it has gone.',
        body: `${what}<p>It went at ${clock(/** @type {string} */ (entry.finishedAt))}.</p>`,
      }
    case 'failed':
      return {
        title: 'Did not go',
        tone: 'neutral',
        heading: 'It did not go: it failed when it ran.',
        body: `${what}<p>Nothing to undo.</p>`,
      }
  }
}

/**
 * "1m 59s": seconds count while the wait is short, which is when someone is deciding.
 *
 * @param {number} ms
 * @returns {string}
 */
function countdown(ms) {
  const s = Math.floor(ms / 1000)
  if (s >= 3600) return formatDuration(ms)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

/**
 * "14:32:05 UTC, 16 Oct 2026". The page cannot know the reader's time zone without
 * scripts, so it says UTC rather than guess.
 *
 * @param {string} iso
 * @returns {string}
 */
function clock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'an unknown time'
  const time = d.toISOString().slice(11, 19)
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${time} UTC, ${date}`
}

/**
 * @param {string} text
 * @returns {string}
 */
function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * @param {IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  let size = 0
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('Body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {Page} p
 */
function page(res, status, p) {
  res.writeHead(status, HEADERS)
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(p.title)}</title>
<style>
:root { --bg: #f6f7f9; --card: #ffffff; --text: #18202b; --muted: #5b6573; --line: #dde2e8; --accent: #b42318; --accent-text: #ffffff; --done: #157f3b; --late: #8a5a00; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1b2d; --card: #16233a; --text: #eef1f5; --muted: #a3aebd; --line: #243452; --accent: #f04438; --accent-text: #ffffff; --done: #4ade80; --late: #fbbf24; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
h1 { margin: 0 0 16px; font-size: 1.375rem; line-height: 1.3; }
.done h1 { color: var(--done); }
.late h1 { color: var(--late); }
.what { margin: 0 0 12px; padding: 12px 14px; border-left: 3px solid var(--line); background: var(--bg); border-radius: 4px; color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
p { margin: 0 0 12px; color: var(--muted); }
button { width: 100%; margin-top: 8px; padding: 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
button:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
</style>
</head>
<body>
<main class="${p.tone ?? 'neutral'}">
<h1>${escape(p.heading)}</h1>
${p.body}
</main>
</body>
</html>
`)
}
