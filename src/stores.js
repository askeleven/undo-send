import { open, readFile, rename, link, unlink, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { UndoSendError, errorCode } from './errors.js'
import { STATUSES } from './outbox.js'

/**
 * @typedef {import('./outbox.js').Entry} Entry
 * @typedef {import('./outbox.js').Status} Status
 *
 * Where the outbox keeps its entries. Four async methods; write your own for any
 * database that can do an atomic insert-if-absent and a compare-and-set.
 *
 * Entries are plain JSON. Store them whole and hand them back unchanged.
 *
 * @typedef {object} Store
 * @property {(key: string, entry: Entry) => Promise<boolean>} claim
 *   Inserts the entry only if no entry exists for the key. Resolves true only if this
 *   call inserted it. Must be atomic: when two callers race, exactly one gets true.
 *   Must be durable before it resolves true: an undo link is handed out next.
 * @property {(key: string, from: Status, entry: Entry) => Promise<boolean>} transition
 *   Replaces the entry only if the stored one's status is `from`. Resolves true only if
 *   it replaced it. Must be atomic (compare-and-set).
 * @property {(key: string) => Promise<Entry | null>} get
 * @property {(filter?: { status?: Status }) => Promise<Entry[]>} list
 *   Every entry, or only those with the given status. Returning more than asked for is
 *   allowed; the outbox filters again.
 */

// ---------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------

/**
 * Keeps entries in a Map. For tests, and for a single process that never restarts:
 * everything is forgotten on exit, including what was held, so anything not yet sent is
 * lost on a restart.
 *
 * Entries are copied through JSON on the way in and out, so it behaves like the stores
 * that persist (a Date in `payload` comes back as a string, as it would from a file).
 *
 * @returns {Store}
 */
export function memoryStore() {
  /** @type {Map<string, string>} */
  const entries = new Map()
  const load = (/** @type {string} */ json) => /** @type {Entry} */ (JSON.parse(json))

  return {
    async claim(key, entry) {
      if (entries.has(key)) return false
      entries.set(key, JSON.stringify({ ...entry, key }))
      return true
    },
    async transition(key, from, entry) {
      const current = entries.get(key)
      if (current === undefined || load(current).status !== from) return false
      entries.set(key, JSON.stringify({ ...entry, key }))
      return true
    },
    async get(key) {
      const current = entries.get(key)
      return current === undefined ? null : load(current)
    },
    async list(filter = {}) {
      return [...entries.values()].map(load).filter((e) => !filter.status || e.status === filter.status)
    },
  }
}

// ---------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------

/**
 * @typedef {object} FileStoreOptions
 * @property {number} [lockTimeoutMs] How long to wait for the lock before giving up with
 *   a `lock_timeout` error. Default 10000.
 * @property {number} [staleLockMs] A lock older than this whose process is gone is
 *   removed. Default 30000.
 */

/**
 * An append-only JSON Lines file: one entry per line, and the last line for a key is
 * its current state. Nothing is ever rewritten, so the file is also the history.
 *
 * Claims and transitions take a lock file next to it (`<path>.lock`, created with
 * O_EXCL), read the file, check, append, and fsync before releasing the lock. That makes
 * them atomic across every process on the machine, and durable before the outbox acts on
 * your send.
 *
 * A lock whose process has died is removed once it is older than `staleLockMs`. A lock
 * held by a process that is still running, or by another host, is never taken over:
 * after `lockTimeoutMs` the call fails with `lock_timeout` and names the file.
 *
 * Limits: one machine, local disk. The lock is not safe on network filesystems. Every
 * operation reads the whole file, which is fine for tens of thousands of entries. Beyond
 * that, or across machines, implement the four Store methods over your database.
 *
 * @param {string} path
 * @param {FileStoreOptions} [options]
 * @returns {Store}
 */
export function fileStore(path, options = {}) {
  if (typeof path !== 'string' || path === '') throw new TypeError('fileStore needs a file path.')
  const { lockTimeoutMs = 10_000, staleLockMs = 30_000 } = options
  const lockPath = `${path}.lock`

  /** @returns {Promise<string>} */
  async function readText() {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return ''
      throw error
    }
  }

  /**
   * @param {Entry} entry
   * @param {string} text The file as it was read under the lock.
   */
  async function append(entry, text) {
    // A crash mid-write can leave a last line with no newline. Start on a fresh line so
    // the torn one stays torn instead of swallowing this entry.
    const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : ''
    const handle = await open(path, 'a')
    try {
      await handle.write(`${lead}${JSON.stringify(entry)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withLock(fn) {
    const token = await acquireLock()
    try {
      return await fn()
    } finally {
      await releaseLock(token)
    }
  }

  /** @returns {Promise<string>} */
  async function acquireLock() {
    const token = randomBytes(8).toString('hex')
    const body = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() })
    const deadline = Date.now() + lockTimeoutMs
    let delay = 2
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx')
        try {
          await handle.writeFile(body)
        } finally {
          await handle.close()
        }
        return token
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
      }
      if (await breakIfStale()) continue
      if (Date.now() >= deadline) {
        throw new UndoSendError(
          'lock_timeout',
          `Could not lock ${path} within ${lockTimeoutMs}ms: ${lockPath} is held. ` +
            'If no process using this outbox is running, delete the lock file.',
        )
      }
      await new Promise((r) => setTimeout(r, delay + Math.random() * delay))
      delay = Math.min(delay * 2, 50)
    }
  }

  /** @param {string} token */
  async function releaseLock(token) {
    try {
      const held = parseLock(await readFile(lockPath, 'utf8'))
      if (held?.token === token) await unlink(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }

  /**
   * Removes the lock if its holder is gone. True when the caller should try again at
   * once (the lock was removed, or had already vanished).
   *
   * @returns {Promise<boolean>}
   */
  async function breakIfStale() {
    let text
    let modified
    try {
      text = await readFile(lockPath, 'utf8')
      modified = (await stat(lockPath)).mtimeMs
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      throw error
    }
    const held = parseLock(text)
    const age = Date.now() - (held?.at ?? modified)
    if (age < staleLockMs) return false
    // An unreadable lock this old was left by a process that died between creating it
    // and writing to it. A readable one is only stale if its process is gone, which can
    // only be checked on the same host.
    if (held && (held.host !== hostname() || isAlive(held.pid))) return false

    // Move it aside under a unique name, then confirm it is the lock that was judged
    // stale. Another process may have removed that one and locked again in between.
    const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
    try {
      await rename(lockPath, aside)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true
      throw error
    }
    const moved = await readFile(aside, 'utf8').catch(() => '')
    if (moved !== text) {
      // That was a live lock. Put it back, unless someone has locked again since.
      await link(aside, lockPath).catch(() => {})
    }
    await unlink(aside).catch(() => {})
    return true
  }

  return {
    async claim(key, entry) {
      return withLock(async () => {
        const text = await readText()
        if (parseOutbox(text).entries.has(key)) return false
        await append({ ...entry, key }, text)
        return true
      })
    },
    async transition(key, from, entry) {
      return withLock(async () => {
        const text = await readText()
        const current = parseOutbox(text).entries.get(key)
        if (!current || current.status !== from) return false
        await append({ ...entry, key }, text)
        return true
      })
    },
    // Reads take no lock. A line still being written is skipped, which shows the
    // previous state; the outbox never decides anything from a read alone.
    async get(key) {
      return parseOutbox(await readText()).entries.get(key) ?? null
    },
    async list(filter = {}) {
      const all = [...parseOutbox(await readText()).entries.values()]
      return all.filter((e) => !filter.status || e.status === filter.status)
    },
  }
}

/**
 * Reads an outbox file's text into the current state of each entry.
 *
 * Lines that are not JSON entries are skipped and counted. A torn line is a write that
 * did not finish, from a crash or a write in flight. The claim or transition it belonged
 * to never returned true, so nothing was held, cancelled or sent on the strength of it.
 *
 * @param {string} text
 * @returns {{ entries: Map<string, Entry>, skipped: number }}
 */
export function parseOutbox(text) {
  /** @type {Map<string, Entry>} */
  const entries = new Map()
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped++
      continue
    }
    if (isEntry(parsed)) entries.set(parsed.key, parsed)
    else skipped++
  }
  return { entries, skipped }
}

/**
 * @param {unknown} value
 * @returns {value is Entry}
 */
function isEntry(value) {
  if (!value || typeof value !== 'object') return false
  const v = /** @type {Record<string, unknown>} */ (value)
  return (
    typeof v.key === 'string' &&
    typeof v.status === 'string' && STATUSES.includes(/** @type {any} */ (v.status)) &&
    typeof v.action === 'string' &&
    typeof v.heldAt === 'string' &&
    typeof v.dueAt === 'string'
  )
}

/**
 * @param {string} text
 * @returns {{ pid: number, host: string, token: string, at: number } | null}
 */
function parseLock(text) {
  try {
    const v = JSON.parse(text)
    if (
      v && typeof v.pid === 'number' && typeof v.host === 'string' &&
      typeof v.token === 'string' && typeof v.at === 'number'
    ) {
      return v
    }
  } catch {
    // Empty or half-written: treated as unreadable.
  }
  return null
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return errorCode(error) === 'EPERM'
  }
}
