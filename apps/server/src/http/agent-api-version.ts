import { agentApi, agentApiHeader, agentApiVersion } from "@wayfarerlabs/agention-api";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "../errors.ts";
import { parse } from "./input.ts";

// The agent API's version, as the agent mount speaks it: every answer states
// the version this server speaks, and a request stating one it does not
// serve is refused before anything else reads it.

// stateAgentApiVersion states this server's version on every answer on the
// agent mount, its refusals included, once the answer is made.
export const stateAgentApiVersion: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set(agentApiHeader, String(agentApi.version));
};

// statedAgentApiVersion reads the version a request states, a missing header
// meaning 1, refusing a header that is no version as invalid_input. Past
// requireServedAgentApiVersion it is one the server serves.
export function statedAgentApiVersion(c: Context): bigint {
  return parse(agentApiVersion, c.req.header(agentApiHeader), agentApiHeader);
}

// requireServedAgentApiVersion refuses a request stating a version above this
// server's or below the oldest it serves, a missing header meaning 1, before
// authentication or any other work. The refusal is worded for the agent, as
// the bridge's own problems are, so a bridge that relays it as it is tells the
// agent what the operator updates. Anyone who reaches the server can read it,
// so it names the versions the server serves, never its release. The server
// and the plugin are released on lines of their own, so the fix is the newest
// release of the one behind: Agention's bridges refuse an older server's
// answers before relaying them, so only other clients read the first.
export const requireServedAgentApiVersion: MiddlewareHandler = async (c, next) => {
  const version = statedAgentApiVersion(c);
  const served =
    `This session's Agention bridge speaks version ${version} of the agent API, and the ` +
    `Agention server serves versions ${agentApi.oldest} to ${agentApi.version}`;
  if (version > agentApi.version) {
    throw unsupported(
      served,
      "upgrade the Agention server to its newest release, and restart this session, resuming it " +
        "to keep this conversation",
    );
  }
  if (version < agentApi.oldest) {
    throw unsupported(
      served,
      "update the Agention plugin to its newest release, and restart this session, resuming it " +
        "to keep this conversation",
    );
  }
  await next();
};

// unsupported is the refusal of a version: problem is a sentence without its
// period, and fix what the operator does.
function unsupported(problem: string, fix: string): ApiError {
  return new ApiError(
    "unsupported_version",
    `${problem}. Only the operator can fix that, so tell them at your terminal to ${fix}. ` +
      "Carry on meanwhile, and try again at natural points.",
  );
}
