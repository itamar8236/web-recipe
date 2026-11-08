// A failure with the code the user's card shows. `retryable` says whether Workflows may
// run the stage again; anything else stops the import at once.
export class ImportError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = 'ImportError';
    this.code = code;
    this.retryable = retryable;
  }
}
