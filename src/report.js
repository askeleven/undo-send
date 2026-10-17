import { formatDuration } from './duration.js'

/**
 * @typedef {import('./outbox.js').Entry} Entry
 * @typedef {import('./outbox.js').Status} Status
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
}

const STATUS_COLOURS = /** @type {Record<Status, string>} */ ({
  held: COLOURS.cyan,
  cancelled: COLOURS.dim,
  executing: COLOURS.yellow,
  sent: COLOURS.green,
  failed: COLOURS.red,
})

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * "in 1m 20s" or "3m ago".
 *
 * @param {string} iso
 * @param {number} now
 * @returns {string}
 */
export function relative(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  if (Math.abs(t - now) < 1000) return 'just now'
  return t >= now ? `in ${formatDuration(t - now)}` : `${formatDuration(now - t)} ago`
}

/**
 * One line per entry: status, id, when, action and summary.
 *
 * @param {Entry[]} entries
 * @param {{ now: number, colour?: boolean }} options
 * @returns {string}
 */
export function formatList(entries, { now, colour = false }) {
  if (entries.length === 0) return 'Nothing in the outbox.\n'
  const paint = painter(colour)
  const idWidth = Math.max(...entries.map((e) => e.key.length))
  const whens = entries.map((e) =>
    e.status === 'held' ? `due ${relative(e.dueAt, now)}` : `${e.status} ${relative(settledAt(e), now)}`,
  )
  const whenWidth = Math.max(...whens.map((w) => w.length))
  const actionWidth = Math.max(...entries.map((e) => e.action.length))
  const lines = entries.map((e, i) => {
    const when = whens[i]
    const status = paint(STATUS_COLOURS[e.status] ?? '', e.status.padEnd(9))
    return `${status}  ${e.key.padEnd(idWidth)}  ${when.padEnd(whenWidth)}  ${e.summary ? `${e.action.padEnd(actionWidth)}  ${paint(COLOURS.dim, e.summary)}` : e.action}`
  })
  const held = entries.filter((e) => e.status === 'held').length
  const stuck = entries.filter((e) => e.status === 'executing').length
  const notes = [`${held} held`]
  if (stuck) notes.push(paint(COLOURS.yellow, `${stuck} executing: if that lasts, check whether it went, then resolve it`))
  return `${lines.join('\n')}\n\n${notes.join(', ')}\n`
}

/**
 * Every field of one entry, for `undo-send show`.
 *
 * @param {Entry} e
 * @param {{ now: number, colour?: boolean }} options
 * @returns {string}
 */
export function formatEntry(e, { now, colour = false }) {
  const paint = painter(colour)
  /** @type {Array<[string, string | undefined]>} */
  const rows = [
    ['id', e.key],
    ['status', paint(STATUS_COLOURS[e.status] ?? '', e.status)],
    ['action', e.action],
    ['summary', e.summary],
    ['by', e.by],
    ['held', `${e.heldAt} (${relative(e.heldAt, now)})`],
    ['due', `${e.dueAt} (${relative(e.dueAt, now)})`],
    ['cancelled', e.cancelledAt && `${e.cancelledAt}${e.cancelledBy ? ` by ${e.cancelledBy}` : ''}`],
    ['reason', e.reason],
    ['started', e.startedAt],
    ['finished', e.finishedAt],
    ['error', e.error],
    ['resolved by', e.resolvedBy],
    ['note', e.note],
    ['result', e.result === undefined ? undefined : JSON.stringify(e.result)],
    ['payload', JSON.stringify(e.payload)],
  ]
  const shown = rows.filter((r) => r[1] !== undefined && r[1] !== '')
  const width = Math.max(...shown.map((r) => r[0].length))
  let out = shown.map(([k, v]) => `${paint(COLOURS.dim, k.padEnd(width))}  ${v}`).join('\n')
  if (e.status === 'executing') {
    out +=
      '\n\n' +
      paint(
        COLOURS.yellow,
        'This started and has not finished. If the process running it has died, nobody knows ' +
          'whether it went. Check with the provider, then run: undo-send resolve ' +
          `${e.key} sent (or failed). It is never retried on its own.`,
      )
  }
  return `${out}\n`
}

/**
 * @param {Entry} e
 * @returns {string}
 */
function settledAt(e) {
  return e.finishedAt ?? e.cancelledAt ?? e.startedAt ?? e.dueAt
}
