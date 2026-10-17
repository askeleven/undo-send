import { randomBytes } from 'node:crypto'
import { UndoSendError, errorMessage } from './errors.js'
import { parseDuration, clockFrom } from './duration.js'
import { undoToken, verifyUndoToken, MIN_SECRET_LENGTH } from './links.js'

/**
 * @typedef {import('./stores.js').Store} Store
 * @typedef {import('./duration.js').Duration} Duration
 * @typedef {import('./duration.js').Clock} Clock
 *
 * @typedef {'held'|'cancelled'|'executing'|'sent'|'failed'} Status
 *   held: waiting out its delay, and can be undone. cancelled: undone; it will never run.
 *   executing: its executor was called and has not returned. If that lasts, the process
 *   died mid-send and nobody knows whether it went: settle it with resolve().
 *   sent: the executor returned. failed: the executor threw.
 *
 * @typedef {object} Entry
 * @property {string} key The id.
 * @property {Status} status
 * @property {string} action Which executor runs it, such as 'email'.
 * @property {unknown} payload What the executor is given. Stored as JSON.
 * @property {string} [summary] One line for a person: what will happen, to whom.
 * @property {string} [by] Who or what held it, such as an agent's name.
 * @property {string} heldAt ISO 8601.
 * @property {string} dueAt ISO 8601. When it runs unless undone.
 * @property {string} [cancelledAt]
 * @property {string} [cancelledBy]
 * @property {string} [reason] Why it was cancelled.
 * @property {string} [startedAt]
 * @property {string} [finishedAt]
 * @property {unknown} [result] What the executor returned, when it is small JSON.
 * @property {string} [error] What the executor threw.
 * @property {string} [resolvedBy] Who settled an entry stuck in executing.
 * @property {string} [note]
 *
 * @typedef {(payload: any, entry: Entry) => unknown | Promise<unknown>} Executor
 *
 * @typedef {object} OutboxOptions
 * @property {Duration} [delay] How long an action waits before it runs. Default '2m'.
 * @property {string} [secret] Signs undo links. At least 32 characters; keep it out of
 *   source control. Without it, hold() returns no undoUrl.
 * @property {string} [baseUrl] Where `undo-send serve` is reachable, such as
 *   'https://undo.example.com'. Needed for undoUrl.
 * @property {Clock} [now] The clock, for tests.
 *
 * @typedef {object} HoldOptions
 * @property {string} [summary] One line a person will see on the undo page and in
 *   `undo-send list`: "Email to dana@acme.com: Your quote".
 * @property {Duration} [delay] Overrides the outbox's delay for this action.
 * @property {string} [id] Your own id, to make holding idempotent: holding the same id
 *   again returns the existing entry instead of a second one.
 * @property {string} [by] Who or what is holding it.
 *
 * @typedef {object} HoldResult
 * @property {'held'|'duplicate'} outcome duplicate: an entry with this id already
 *   existed, and nothing new was held. Look at entry.status to see where it is.
 * @property {string} id
 * @property {string} dueAt
 * @property {string | null} undoUrl
 * @property {Entry} entry
 *
 * @typedef {object} CancelResult
 * @property {'cancelled'|'already_cancelled'|'too_late'|'not_found'} outcome too_late:
 *   it has started or finished running.
 * @property {Entry | null} entry
 *
 * @typedef {object} RunResult
 * @property {string} id
 * @property {'sent'|'failed'|'no_executor'|'lost_race'} outcome lost_race: it was
 *   cancelled, or another runner took it, between being read and being started.
 *   no_executor: nothing is registered for its action in this outbox; it stays held.
 * @property {Entry | null} entry
 */

/** @type {readonly Status[]} */
export const STATUSES = ['held', 'cancelled', 'executing', 'sent', 'failed']

export const DEFAULT_DELAY = '2m'

/** Results bigger than this as JSON are not stored. */
const MAX_RESULT_JSON = 2000

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * An outbox that holds each action for a while before running it, so a person can undo
 * it. Holding, cancelling and starting are each one atomic compare-and-set on the store,
 * so an action is either undone or run, never both, whichever process gets there first.
 *
 * @param {Store} store
 * @param {OutboxOptions} [options]
 */
export function createOutbox(store, options = {}) {
  if (!store || typeof store.claim !== 'function' || typeof store.transition !== 'function') {
    throw new UndoSendError('invalid_option', 'createOutbox needs a store, such as fileStore(path).')
  }
  const defaultDelay = parseDuration(options.delay ?? DEFAULT_DELAY)
  const clock = clockFrom(options.now)
  const secret = options.secret
  if (secret !== undefined && (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)) {
    throw new UndoSendError('invalid_option', `secret must be a string of at least ${MIN_SECRET_LENGTH} characters.`)
  }
  const baseUrl = options.baseUrl?.replace(/\/+$/, '')
  if (baseUrl !== undefined && !/^https?:\/\/[^\s/]+/.test(baseUrl)) {
    throw new UndoSendError('invalid_option', `baseUrl must be an http or https URL, got ${options.baseUrl}.`)
  }

  /** @type {Map<string, Executor>} */
  const executors = new Map()
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString()

  /**
   * @param {string} id
   * @returns {string | null}
   */
  function undoUrlFor(id) {
    if (!secret || !baseUrl) return null
    return `${baseUrl}/undo/${encodeURIComponent(id)}?t=${undoToken(secret, id)}`
  }

  /**
   * @param {string} id
   * @returns {Promise<Entry>}
   */
  async function mustGet(id) {
    const entry = await store.get(id)
    if (!entry) {
      throw new UndoSendError('store_inconsistent', `The store accepted a write for ${id} but returned nothing for it.`)
    }
    return entry
  }

  const outbox = {
    /**
     * Registers the function that runs an action. One per action name.
     *
     * @param {string} action
     * @param {Executor} executor
     */
    register(action, executor) {
      if (typeof action !== 'string' || !action) throw new TypeError('register needs an action name.')
      if (typeof executor !== 'function') throw new TypeError(`register('${action}') needs a function.`)
      executors.set(action, executor)
      return outbox
    },

    /**
     * Holds an action. It runs after the delay unless someone undoes it first.
     *
     * @param {string} action
     * @param {unknown} payload Must survive JSON: it is stored until it runs.
     * @param {HoldOptions} [opts]
     * @returns {Promise<HoldResult>}
     */
    async hold(action, payload, opts = {}) {
      if (typeof action !== 'string' || !action) throw new TypeError('hold needs an action name.')
      const id = opts.id ?? `u_${randomBytes(8).toString('base64url')}`
      if (!ID_PATTERN.test(id)) {
        throw new UndoSendError('invalid_option', `id must be 1 to 128 letters, digits or . _ : -, got ${id}.`)
      }
      let stored
      try {
        stored = JSON.parse(JSON.stringify(payload ?? null))
      } catch (error) {
        throw new UndoSendError('invalid_option', `payload must be JSON: ${errorMessage(error)}`)
      }
      const delay = opts.delay === undefined ? defaultDelay : parseDuration(opts.delay)
      const now = clock()
      /** @type {Entry} */
      const entry = {
        key: id,
        status: 'held',
        action,
        payload: stored,
        heldAt: iso(now),
        dueAt: iso(now + delay),
      }
      if (opts.summary !== undefined) entry.summary = String(opts.summary).slice(0, 500)
      if (opts.by !== undefined) entry.by = String(opts.by)

      const claimed = await store.claim(id, entry)
      const current = claimed ? entry : await mustGet(id)
      return {
        outcome: claimed ? 'held' : 'duplicate',
        id,
        dueAt: current.dueAt,
        undoUrl: current.status === 'held' ? undoUrlFor(id) : null,
        entry: current,
      }
    },

    /**
     * Undoes a held action. Only works while it is still held.
     *
     * @param {string} id
     * @param {{ by?: string, reason?: string }} [opts]
     * @returns {Promise<CancelResult>}
     */
    async cancel(id, opts = {}) {
      const entry = await store.get(id)
      if (!entry) return { outcome: 'not_found', entry: null }
      if (entry.status === 'cancelled') return { outcome: 'already_cancelled', entry }
      if (entry.status !== 'held') return { outcome: 'too_late', entry }
      /** @type {Entry} */
      const next = { ...entry, status: 'cancelled', cancelledAt: iso(clock()) }
      if (opts.by !== undefined) next.cancelledBy = String(opts.by)
      if (opts.reason !== undefined) next.reason = String(opts.reason)
      if (await store.transition(id, 'held', next)) return { outcome: 'cancelled', entry: next }
      // Something else moved it first: a runner started it, or someone else undid it.
      const now = await mustGet(id)
      return { outcome: now.status === 'cancelled' ? 'already_cancelled' : 'too_late', entry: now }
    },

    /**
     * Skips the rest of the wait: the action runs on the next run().
     *
     * @param {string} id
     * @returns {Promise<{ outcome: 'released'|'too_late'|'not_found', entry: Entry | null }>}
     */
    async sendNow(id) {
      const entry = await store.get(id)
      if (!entry) return { outcome: 'not_found', entry: null }
      if (entry.status !== 'held') return { outcome: 'too_late', entry }
      /** @type {Entry} */
      const next = { ...entry, dueAt: iso(clock()) }
      if (await store.transition(id, 'held', next)) return { outcome: 'released', entry: next }
      return { outcome: 'too_late', entry: await mustGet(id) }
    },

    /**
     * Runs every held action that is due and has an executor here, one at a time, oldest
     * due first. Safe to call from several processes at once: each action starts once.
     *
     * @param {{ limit?: number }} [opts]
     * @returns {Promise<RunResult[]>}
     */
    async run(opts = {}) {
      const now = clock()
      const due = (await store.list({ status: 'held' }))
        .filter((e) => e.status === 'held' && Date.parse(e.dueAt) <= now)
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
        .slice(0, opts.limit ?? Infinity)

      /** @type {RunResult[]} */
      const results = []
      for (const entry of due) {
        const executor = executors.get(entry.action)
        if (!executor) {
          results.push({ id: entry.key, outcome: 'no_executor', entry })
          continue
        }
        /** @type {Entry} */
        const started = { ...entry, status: 'executing', startedAt: iso(clock()) }
        if (!(await store.transition(entry.key, 'held', started))) {
          results.push({ id: entry.key, outcome: 'lost_race', entry: await store.get(entry.key) })
          continue
        }
        /** @type {Entry} */
        let finished
        try {
          const value = await executor(started.payload, started)
          finished = { ...started, status: 'sent', finishedAt: iso(clock()) }
          const result = storable(value)
          if (result !== undefined) finished.result = result
        } catch (error) {
          finished = { ...started, status: 'failed', finishedAt: iso(clock()), error: errorMessage(error).slice(0, 1000) }
        }
        if (!(await store.transition(entry.key, 'executing', finished))) {
          throw new UndoSendError(
            'store_inconsistent',
            `${entry.key} ran, but its status was no longer executing when the result was written.`,
          )
        }
        results.push({ id: entry.key, outcome: finished.status === 'sent' ? 'sent' : 'failed', entry: finished })
      }
      return results
    },

    /**
     * Calls run() on a timer until stopped. Runs never overlap.
     *
     * @param {{ every?: Duration, onResult?: (r: RunResult) => void, onError?: (e: unknown) => void }} [opts]
     * @returns {{ stop: () => Promise<void> }}
     */
    start(opts = {}) {
      const every = parseDuration(opts.every ?? '1s')
      let stopped = false
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer
      /** @type {Promise<void>} */
      let current = Promise.resolve()
      const tick = () => {
        current = outbox
          .run()
          .then((results) => {
            for (const r of results) opts.onResult?.(r)
          })
          .catch((error) => {
            if (opts.onError) opts.onError(error)
            else process.stderr.write(`undo-send: ${errorMessage(error)}\n`)
          })
          .finally(() => {
            if (!stopped) timer = setTimeout(tick, every)
          })
      }
      tick()
      return {
        async stop() {
          stopped = true
          clearTimeout(timer)
          await current
        },
      }
    },

    /**
     * Settles an action left in executing, after checking with the provider whether it
     * went. Never decided automatically.
     *
     * @param {string} id
     * @param {'sent'|'failed'} status
     * @param {{ by?: string, note?: string }} [opts]
     * @returns {Promise<{ outcome: 'resolved'|'not_executing'|'not_found', entry: Entry | null }>}
     */
    async resolve(id, status, opts = {}) {
      if (status !== 'sent' && status !== 'failed') throw new TypeError("resolve needs 'sent' or 'failed'.")
      const entry = await store.get(id)
      if (!entry) return { outcome: 'not_found', entry: null }
      if (entry.status !== 'executing') return { outcome: 'not_executing', entry }
      /** @type {Entry} */
      const next = { ...entry, status, finishedAt: iso(clock()) }
      if (opts.by !== undefined) next.resolvedBy = String(opts.by)
      if (opts.note !== undefined) next.note = String(opts.note)
      if (await store.transition(id, 'executing', next)) return { outcome: 'resolved', entry: next }
      return { outcome: 'not_executing', entry: await mustGet(id) }
    },

    /**
     * @param {string} id
     * @returns {Promise<Entry | null>}
     */
    get(id) {
      return store.get(id)
    },

    /**
     * Entries, soonest due first.
     *
     * @param {{ status?: Status }} [filter]
     * @returns {Promise<Entry[]>}
     */
    async list(filter = {}) {
      const all = await store.list(filter)
      return all
        .filter((e) => !filter.status || e.status === filter.status)
        .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
    },

    /**
     * The undo link for an id, or null without a secret and baseUrl.
     *
     * @param {string} id
     * @returns {string | null}
     */
    undoUrl(id) {
      return undoUrlFor(id)
    },

    /**
     * Whether a token from an undo link is valid for this id. False without a secret.
     *
     * @param {string} id
     * @param {unknown} token
     * @returns {boolean}
     */
    checkUndoToken(id, token) {
      return Boolean(secret) && verifyUndoToken(/** @type {string} */ (secret), id, token)
    },

    /** The clock this outbox uses, in milliseconds. */
    now() {
      return clock()
    },
  }
  return outbox
}

/** @typedef {ReturnType<typeof createOutbox>} Outbox */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function storable(value) {
  if (value === undefined) return undefined
  try {
    const json = JSON.stringify(value)
    if (json === undefined || json.length > MAX_RESULT_JSON) return undefined
    return JSON.parse(json)
  } catch {
    return undefined
  }
}
