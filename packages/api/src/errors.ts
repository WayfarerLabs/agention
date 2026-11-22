import { z } from "zod";
import { message } from "./threads.ts";

// The error codes the API answers with, on every route and in the agent
// bridge's tool errors, and the HTTP status each is sent with.
export const statusByErrorCode = {
  // The input breaks a bound, the shape or a rule about the thread's messages;
  // the error names the input at fault.
  invalid_input: 400,
  // The request states a version of the agent API this server does not
  // serve; the message, worded for the agent, says what the operator updates.
  unsupported_version: 400,
  // A missing, invalid, expired or revoked credential.
  unauthenticated: 401,
  // The caller may see the target, but does not hold what the change needs:
  // the role in a thread, a message's authorship, or a recent sign-in.
  not_allowed: 403,
  // The target does not exist, or the caller may not access it; the two are
  // indistinguishable by design.
  not_found: 404,
  // Another message landed on the thread after the latest one the writer had
  // seen; the error carries the messages the writer missed.
  stale: 409,
  // A request id was reused with different content.
  request_id_conflict: 409,
  // A name the request gives already belongs to another of its kind, as a
  // group's or a tag's can on the web mount; the error names the input.
  conflict: 409,
  // A rate budget is exhausted.
  rate_limited: 429,
  // On the web mount only: the transcription provider failed or could not be
  // reached; the message says which, never what the provider answered.
  provider_failed: 502,
  // Anything else; details go only to the server log.
  internal: 500,
} as const;

export type ErrorCode = keyof typeof statusByErrorCode;

// Request bodies are the exceptions to the table: a body over the size limit,
// and one sent without a declared length (chunked), are invalid_input, sent
// with these statuses instead of 400.
export const oversizedBodyStatus = 413;
export const unsizedBodyStatus = 411;

export const errorCode = z.enum(Object.keys(statusByErrorCode) as [ErrorCode, ...ErrorCode[]]);

// The one error shape, on both API mounts and in the bridge's tool errors.
// field names the input at fault, as a dotted path such as "references.2.url".
export const errorBody = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    field: z.string().optional(),
    missed: z.array(message).optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBody>;

// invalidInputBody describes the first problem a schema found in an input.
export function invalidInputBody(error: z.ZodError): ErrorBody {
  const issue = error.issues[0];
  const field = issue?.path.join(".") ?? "";
  return {
    error: {
      code: "invalid_input",
      message: issue?.message ?? "invalid input",
      ...(field === "" ? {} : { field }),
    },
  };
}
