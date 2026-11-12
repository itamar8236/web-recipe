// A failure with the code the user's card shows. `retryable` says whether Workflows may
// run the stage again; anything else stops the import at once. `detail` is what went
// wrong in words (e.g. Google's message), kept for debugging and never shown to users.
export class ImportError extends Error {
  constructor(code, { retryable = false, detail = null } = {}) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}
