/**
 * @typedef {'lock_timeout'|'unknown_action'|'invalid_option'|'store_inconsistent'} UndoSendErrorCode
 */

/** Something undo-send refused to do, or could not do safely. Match on `code`. */
export class UndoSendError extends Error {
  /**
   * @param {UndoSendErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'UndoSendError'
    /** @type {UndoSendErrorCode} */
    this.code = code
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The `code` of a Node system error, if it has one.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function errorCode(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
