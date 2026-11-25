import {
  agentApi,
  agentApiHeader,
  agentApiVersion,
  codeLinksAgentApiVersion,
} from "@wayfarerlabs/agention-api";
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../errors.ts";
import { parse } from "./input.ts";

// The agent API's version, as the agent mount speaks it: every answer states
// the version this server speaks, a request stating one it does not serve is
// refused before anything else reads it, and an answer to one it serves
// leaves out the fields added after the version the request states.

// The variables of the agent mount's routes: the version the request states.
export interface AgentApiVersionEnv {
  Variables: { agentApiVersion: bigint };
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
// so it names the versions the server serves, never its release. The server
// and the plugin are released on lines of their own, so the fix is the newest
// release of the one behind: Agention's bridges refuse an older server's
// answers before relaying them, so only other clients read the first. A
// version it serves goes on the context, for the answer.
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
  c.set("agentApiVersion", version);
  await next();
};

// answerAsStatedVersion leaves out of a JSON answer, its refusals included,
// the fields added to the agent API after the version the request states: an
// older bridge does not know them, so it could neither use them nor keep them
// within its answer cap. Before codeLinksAgentApiVersion, those are the pull
// requests and branches of a thread read's messages, its roll-up of them, and
// those of the messages a stale write missed. A file is never served as JSON
// (servedTypeOf), so every JSON answer is the API's own. Each JSON answer to
// an older bridge is parsed and written again whole, a cost too small to see
// beside building it.
export const answerAsStatedVersion: MiddlewareHandler<AgentApiVersionEnv> = async (c, next) => {
  await next();
  if (
    c.var.agentApiVersion >= codeLinksAgentApiVersion ||
    c.res.headers.get("content-type")?.startsWith("application/json") !== true
  ) {
    return;
  }
  const answer: unknown = await c.res.json();
  if (isJson(answer)) {
    const messages = [answer.messages, isJson(answer.error) ? answer.error.missed : undefined];
    for (const each of [answer, ...messages.flatMap((list) => (Array.isArray(list) ? list : []))]) {
      if (isJson(each)) {
        delete each.pull_requests;
        delete each.branches;
      }
    }
  }
  c.res = new Response(JSON.stringify(answer), c.res);
};

function isJson(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
