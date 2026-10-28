// Errors that are safe to show to API clients. Anything else becomes a generic 500.
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };
