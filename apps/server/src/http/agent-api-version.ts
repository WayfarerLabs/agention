import { agentApi, agentApiHeader, agentApiVersion } from "@wayfarerlabs/agention-api";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "../errors.ts";
import { parse } from "./input.ts";

// The agent API's version, as the agent mount speaks it: every answer states
// the version this server speaks, and a request stating one it does not
// serve is refused before anything else reads it.

// The agent mount's context carries the version a request states, once
// requireServedAgentApiVersion has parsed it and found it served.
export interface AgentApiVersionEnv {
  Variables: { agentApiVersion: number };
}

// stateAgentApiVersion states this server's version on every answer on the
// agent mount, its refusals included, once the answer is made.
export const stateAgentApiVersion: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set(agentApiHeader, String(agentApi.version));
};

// requireServedAgentApiVersion refuses a request stating a version above this
// server's or below the oldest it serves, a missing header meaning 1, before
// authentication or any other work. The refusal is worded for the agent, as
// the bridge's own problems are, so a bridge that relays it as it is tells the
// agent what the operator updates. Anyone who reaches the server can read it,
// so it names the versions the server serves, never its release.
export const requireServedAgentApiVersion: MiddlewareHandler<AgentApiVersionEnv> = async (
  c,
  next,
) => {
  const version = parse(agentApiVersion, c.req.header(agentApiHeader), agentApiHeader);
  const served =
    `This session's Agention bridge speaks version ${version} of the agent API, and the ` +
    `Agention server serves versions ${agentApi.oldest} to ${agentApi.version}`;
  if (version > agentApi.version) {
    throw unsupported(
      served,
      "upgrade the Agention server to the plugin's release or later, or to pin the Agention " +
        "plugin to a release that matches the server, and restart this session, resuming it to " +
        "keep this conversation",
    );
  }
  if (version < agentApi.oldest) {
    throw unsupported(
      served,
      "update the Agention plugin to the server's release or later, and restart this session, " +
        "resuming it to keep this conversation",
    );
  }
  // A served version is at most this server's, so it fits a number.
  c.set("agentApiVersion", Number(version));
  await next();
};

// requestedAgentApiVersion is the version a request states, as
// requireServedAgentApiVersion parsed it.
export function requestedAgentApiVersion(c: Context<AgentApiVersionEnv>): number {
  return c.var.agentApiVersion;
}

// unsupported is the refusal of a version: problem is a sentence without its
// period, and fix what the operator does.
function unsupported(problem: string, fix: string): ApiError {
  return new ApiError(
    "unsupported_version",
    `${problem}. Only the operator can fix that, so tell them at your terminal to ${fix}. ` +
      "Carry on meanwhile, and try again at natural points.",
  );
}
