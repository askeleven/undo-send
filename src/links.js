import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Shorter secrets are refused: a link is only as hard to forge as the secret is to guess. */
export const MIN_SECRET_LENGTH = 32

/**
 * The token in an undo link: an HMAC-SHA256 of the id, so a link works for that one
 * action and cannot be made for another without the secret.
 *
 * @param {string} secret
 * @param {string} id
 * @returns {string} base64url, 43 characters.
 */
export function undoToken(secret, id) {
  return createHmac('sha256', secret).update(`undo-send:v1:${id}`).digest('base64url')
}

/**
 * Whether a token is the one for this id, compared in constant time.
 *
 * @param {string} secret
 * @param {string} id
 * @param {unknown} token
 * @returns {boolean}
 */
export function verifyUndoToken(secret, id, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128) return false
  const expected = Buffer.from(undoToken(secret, id))
  const given = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/**
 * A new random secret, for UNDO_SEND_SECRET.
 *
 * @returns {string}
 */
export function newSecret() {
  return randomBytes(32).toString('base64url')
}
