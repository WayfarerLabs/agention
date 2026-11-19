import type { ErrorBody, ErrorCode } from "@wayfarerlabs/agention-api";

// A tool fails in one of two ways. ApiFailure is an answer in the API's error
// shape: one the server gave, or one the bridge gives in the server's terms
// because it can tell what the server would say, such as invalid_input for
// arguments outside the shared schemas. BridgeError is a problem with the
// bridge itself, such as its configuration or reaching the server, which the
// API has no code for, and is answered as plain text.

export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly body: ErrorBody;

  constructor(body: ErrorBody) {
    super(body.error.message);
    this.body = body;
  }

  static of(code: ErrorCode, message: string, field?: string): ApiFailure {
    return new ApiFailure({
      error: { code, message, ...(field === undefined ? {} : { field }) },
    });
  }
}

export class BridgeError extends Error {
  override name = "BridgeError";
}
