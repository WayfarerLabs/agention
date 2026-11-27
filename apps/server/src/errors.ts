import type { ErrorBody, ErrorCode, Message } from "@wayfarerlabs/agention-api";

// A refusal of an API key the server found, which the audit log records under
// the key and a fixed code: revoked, expired, or lacking a scope.
export interface KeyRefusal {
  key: number;
  code: "key_revoked" | "key_expired" | "scope";
}

// ApiError is a failure the API reports to its caller in the shared error
// shape. Anything else that escapes an operation is an internal error, whose
// details go only to the server log. A refusal of a known key carries the key
// and why, for the audit log; no answer ever shows them.
export class ApiError extends Error {
  override name = "ApiError";
  readonly code: ErrorCode;
  readonly field: string | undefined;
  readonly missed: Message[] | undefined;
  readonly refusal: KeyRefusal | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details: {
      field?: string | undefined;
      missed?: Message[];
      refusal?: KeyRefusal | undefined;
    } = {},
  ) {
    super(message);
    this.code = code;
    this.field = details.field;
    this.missed = details.missed;
    this.refusal = details.refusal;
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

export function notFound(field?: string, refusal?: KeyRefusal): ApiError {
  return new ApiError("not_found", "not found", { field, refusal });
}

export function notAllowed(field: string | undefined, message: string): ApiError {
  return new ApiError("not_allowed", message, field === undefined ? {} : { field });
}

export function unauthenticated(
  message = "the credential is not valid",
  refusal?: KeyRefusal,
): ApiError {
  return new ApiError("unauthenticated", message, { refusal });
}

// unapprovedKey says why an agent's key acts for no session: no registration
// has it, or its registration has a status other than approved. Both places
// that refuse such a key say it this way.
export function unapprovedKey(status: string | undefined): string {
  return status === undefined
    ? "the agent token's key is not registered"
    : `the key's registration is ${status}, not approved`;
}

// apiKeyUnauthenticated refuses an API key, whatever is wrong with it: missing,
// malformed, unknown, revoked or expired. It never says which, so the refusal
// tells no one whether a key ever existed; a revoked or expired key the server
// found carries its refusal for the audit log alone.
export function apiKeyUnauthenticated(
  refusal?: KeyRefusal & { code: "key_revoked" | "key_expired" },
): ApiError {
  return unauthenticated(
    "the API key is not valid: check it, or create a new one in Agention's Settings",
    refusal,
  );
}

// agentUnauthenticated refuses an agent's credential, telling the agent to
// call register, which reports what the operator still has to do.
export function agentUnauthenticated(reason: string): ApiError {
  return unauthenticated(`${reason}; call register to check this session's registration`);
}
