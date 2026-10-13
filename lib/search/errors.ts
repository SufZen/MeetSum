/**
 * Search failures the routes map to a status (docs/parity/m6.md, B5).
 */

/** Every search leg failed (e.g. statement timeouts): routes answer 503. */
export class SearchUnavailableError extends Error {
  constructor(message = "Search is temporarily unavailable") {
    super(message)
    this.name = "SearchUnavailableError"
  }
}
