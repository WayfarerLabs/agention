import type { ErrorBody, ErrorCode } from "@wayfarerlabs/agention-api";
import packageJson from "../package.json" with { type: "json" };

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

// detailOf names a failure of Node's, such as a file's or a connection's, by
// its code, else its message, for a BridgeError to give in brackets.
export function detailOf(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown };
  return String(failure.code ?? failure.message);
}

// A BridgeError's message is worded for the agent. What only the operator can
// fix, the agent tells them at its terminal, since Agention is what is not
// working.

// The operator guide's section on the bridge's settings, at this bridge's
// release.
const settingsGuide =
  "https://github.com/WayfarerLabs/agention/blob/" +
  `v${packageJson.version}/docs/operator-guide.md#agents`;

// settingProblem is a problem with a setting the agent host gave the bridge
// as the session started, which changes only once the session restarts.
// problem is a sentence without its period, and fix what the operator changes.
export function settingProblem(problem: string, fix: string): BridgeError {
  return new BridgeError(
    `${problem}. Only the operator can fix that, so tell them at your terminal to ${fix}, and ` +
      `then restart the session, resuming it to keep this conversation; ${settingsGuide} says ` +
      "how. Carry on meanwhile, and try again once they have restarted it.",
  );
}

// operatorProblem is a problem the operator fixes while the session runs, on
// the server, the way to it or this machine. problem is a sentence without
// its period, and fix says what the operator does.
export function operatorProblem(problem: string, fix: string, options?: ErrorOptions): BridgeError {
  return new BridgeError(operatorProblemText(problem, fix), options);
}

function operatorProblemText(problem: string, fix: string): string {
  return (
    `${problem}. Only the operator can fix that, so tell them at your terminal to ${fix}. ` +
    "Carry on meanwhile, and try again at natural points."
  );
}

// OlderServer is the operator problem of a server that does not speak the
// bridge's version of the agent API, which nothing the bridge does can
// outlast: the bridge's background wait gives up on it.
export class OlderServer extends BridgeError {
  override name = "OlderServer";

  constructor(problem: string, fix: string) {
    super(operatorProblemText(problem, fix));
  }
}
