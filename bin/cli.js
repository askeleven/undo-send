#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createOutbox, fileStore, createUndoServer, newSecret, STATUSES, UndoSendError, MIN_SECRET_LENGTH } from '../src/index.js'
import { formatList, formatEntry } from '../src/report.js'
import { VERSION } from '../src/version.js'

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '127.0.0.1'

const USAGE = `
undo-send list [--status <status>]
undo-send show <id>
undo-send cancel <id> [--reason <text>]
undo-send send-now <id>
undo-send resolve <id> <sent|failed> [--note <text>]
undo-send serve [--port <n>] [--host <addr>]
undo-send secret

  Looks after an outbox of actions your agent has held back: emails, texts,
  refunds, anything it would regret. Each waits out its delay, then runs,
  unless someone undoes it first. Your code holds and runs them with the
  library; this is for the people watching.

Options
  --outbox <file>       The outbox file. Default $UNDO_SEND_OUTBOX.
  --status <status>     list only these: ${STATUSES.join(', ')}.
  --by <name>           Who is doing this, recorded on the entry. Default $USER.
  --reason <text>       Why it was undone.
  --note <text>         What you found when resolving.
  --port <n>            serve: port. Default $PORT, else ${DEFAULT_PORT}.
  --host <addr>         serve: address. Default ${DEFAULT_HOST}; put a proxy
                        with TLS in front rather than exposing it directly.
  --json                Machine-readable output.
  --no-colour           Plain text.
  --version, --help

serve
  Serves the undo links your outbox hands out. Needs $UNDO_SEND_SECRET, the
  same secret the outbox signs links with. Opening a link only shows what
  will happen and when; the button on the page undoes it, so link previews
  in chat and mail apps cannot.

resolve
  An action that started and never finished is left "executing": the
  process died mid-send, and nobody knows whether it went. It is never
  retried on its own. Check with the provider, then mark it sent or failed.

Exit codes
  0  done
  1  refused: not found, or too late to undo
  2  could not run

Examples
  export UNDO_SEND_OUTBOX=outbox.jsonl
  npx @askeleven/undo-send list --status held
  npx @askeleven/undo-send cancel u_3kP9xq2LmA --reason "wrong customer"
  UNDO_SEND_SECRET=... npx @askeleven/undo-send serve --port 8787
`

const SUBCOMMANDS = ['list', 'show', 'cancel', 'send-now', 'resolve', 'serve', 'secret']

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        outbox: { type: 'string' },
        status: { type: 'string' },
        by: { type: 'string' },
        reason: { type: 'string' },
        note: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const [sub, ...args] = positionals
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    process.stderr.write(`${sub ? `Unknown command: ${sub}\n` : ''}${USAGE}`)
    return 2
  }
  if (sub === 'secret') {
    process.stdout.write(`${newSecret()}\n`)
    return 0
  }

  const path = values.outbox ?? process.env.UNDO_SEND_OUTBOX
  if (!path) {
    process.stderr.write('Give the outbox file with --outbox, or set UNDO_SEND_OUTBOX.\n')
    return 2
  }
  const colour = useColour(values)
  const by = values.by ?? process.env.USER ?? 'cli'

  try {
    if (sub === 'serve') return await serve(path, values)

    const outbox = createOutbox(fileStore(path))
    const now = outbox.now()
    const out = (/** @type {unknown} */ json, /** @type {string} */ text) =>
      process.stdout.write(values.json ? `${JSON.stringify(json, null, 2)}\n` : text)

    if (sub === 'list') {
      const status = values.status
      if (status !== undefined && !STATUSES.includes(/** @type {any} */ (status))) {
        throw new UsageError(`--status must be one of ${STATUSES.join(', ')}.`)
      }
      const entries = await outbox.list({ status: /** @type {any} */ (status) })
      out(entries, formatList(entries, { now, colour }))
      return 0
    }

    const id = args[0]
    if (!id) throw new UsageError(`${sub} needs an id. See undo-send list.`)

    if (sub === 'show') {
      const entry = await outbox.get(id)
      if (!entry) return notFound(id)
      out(entry, formatEntry(entry, { now, colour }))
      return 0
    }

    if (sub === 'cancel') {
      const r = await outbox.cancel(id, { by, reason: values.reason })
      if (r.outcome === 'not_found') return notFound(id)
      const text = {
        cancelled: `Undone: ${id}. It will not run.\n`,
        already_cancelled: `Already undone: ${id}.\n`,
        too_late: `Too late: ${id} is ${r.entry?.status}.\n`,
      }[r.outcome]
      out(r, text)
      return r.outcome === 'too_late' ? 1 : 0
    }

    if (sub === 'send-now') {
      const r = await outbox.sendNow(id)
      if (r.outcome === 'not_found') return notFound(id)
      out(r, r.outcome === 'released' ? `Released: ${id} runs on the runner's next pass.\n` : `Too late: ${id} is ${r.entry?.status}.\n`)
      return r.outcome === 'released' ? 0 : 1
    }

    // resolve
    const status = args[1]
    if (status !== 'sent' && status !== 'failed') throw new UsageError('resolve needs sent or failed after the id.')
    const r = await outbox.resolve(id, status, { by, note: values.note })
    if (r.outcome === 'not_found') return notFound(id)
    out(r, r.outcome === 'resolved' ? `Resolved: ${id} is ${status}.\n` : `Not executing: ${id} is ${r.entry?.status}.\n`)
    return r.outcome === 'resolved' ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError || error instanceof UndoSendError || error instanceof TypeError || error instanceof RangeError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }
}

class UsageError extends Error {}

/**
 * @param {string} path
 * @param {Record<string, any>} values
 * @returns {Promise<number>}
 */
async function serve(path, values) {
  const secret = process.env.UNDO_SEND_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new UsageError(
      `serve needs UNDO_SEND_SECRET, at least ${MIN_SECRET_LENGTH} characters, the same one your outbox signs links with. ` +
        'Make one with: undo-send secret',
    )
  }
  const portText = values.port ?? process.env.PORT ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a port number, got ${portText}.`)
  const host = values.host ?? DEFAULT_HOST

  const server = createUndoServer(createOutbox(fileStore(path), { secret }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(undefined))
  })
  const address = server.address()
  const shown = address && typeof address === 'object' ? `${address.address}:${address.port}` : `${host}:${port}`
  process.stderr.write(`undo-send ${VERSION} serving undo links for ${path} on http://${shown}\n`)
  await new Promise((resolve) => {
    const stop = () => server.close(() => resolve(undefined))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

/**
 * @param {string} id
 * @returns {number}
 */
function notFound(id) {
  process.stderr.write(`Not found: ${id}.\n`)
  return 1
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
