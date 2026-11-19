import type { ErrorBody, ErrorCode, Message } from "@wayfarerlabs/agention-api";

// ApiError is a failure the API reports to its caller in the shared error
// shape. Anything else that escapes an operation is an internal error, whose
// details go only to the server log.
export class ApiError extends Error {
  override name = "ApiError";
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly missed: Message[] | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details: { field?: string; missed?: Message[] } = {},
  ) {
    super(message);
    this.code = code;
    this.field = details.field;
    this.missed = details.missed;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field === undefined ? {} : { field: this.field }),
        ...(this.missed === undefined ? {} : { missed: this.missed }),
      },
    };
  }
}

export function invalidInput(field: string | undefined, message: string): ApiError {
  return new ApiError("invalid_input", message, field === undefined ? {} : { field });
}

export function notFound(field?: string): ApiError {
  return new ApiError("not_found", "not found", field === undefined ? {} : { field });
}

export function notAllowed(field: string | undefined, message: string): ApiError {
  return new ApiError("not_allowed", message, field === undefined ? {} : { field });
}

export function unauthenticated(message = "the credential is not valid"): ApiError {
  return new ApiError("unauthenticated", message);
}

// unapprovedKey says why an agent's key acts for no session: no registration
// has it, or its registration has a status other than approved. Both places
// that refuse such a key say it this way.
export function unapprovedKey(status: string | undefined): string {
  return status === undefined
    ? "the agent token's key is not registered"
    : `the key's registration is ${status}, not approved`;
}

// agentUnauthenticated refuses an agent's credential, telling the agent to
// call register, which reports what the operator still has to do.
export function agentUnauthenticated(reason: string): ApiError {
  return unauthenticated(`${reason}; call register to check this session's registration`);
}
