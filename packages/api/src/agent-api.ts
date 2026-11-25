import { z } from "zod";

// The agent API's version. Every request the bridge makes, and every answer
// on the server's agent mount, states in agentApiHeader the version its
// sender speaks; a missing one means 1, the version of every bridge and server
// released before the header. version is the one this release speaks. The
// server serves every version from oldest to version, and the bridge refuses
// an answer from a server older than itself, so a mismatch fails loudly
// before a field goes missing unnoticed. Every change to the agent contract
// bumps version by one (CONTRIBUTING.md "The agent API"); oldest moves only by
// a maintainer's decision.
export const agentApi = { version: 9, oldest: 1 } as const;

// The versions that added fields to the agent's answers. An answer to a
// request stating an older version leaves out every field added after it, so
// a bridge never reads, or has to fit within its answer cap, a field it does
// not know.

// The first version whose messages carry pull_requests and branches, and whose
// thread reads carry the thread's roll-up of them.
export const codeLinksAgentApiVersion = 6;

// The first version whose thread summaries carry links, which counts the pull
// requests and branches the thread's live messages name.
export const summaryLinksAgentApiVersion = 7;

// The first version whose background polls answer whether a nudge is due.
export const nudgeAgentApiVersion = 9;

export const agentApiHeader = "Agention-Agent-API";

// A version as agentApiHeader carries it: a positive integer written without
// leading zeros, read as 1 when the header is missing. It is read whole,
// however many digits it has, so a version above any this release knows
// compares as above it.
export const agentApiVersion = z
  .string()
  .regex(/^[1-9][0-9]*$/, "must be a positive integer, written without leading zeros")
  .transform((digits) => BigInt(digits))
  .default(1n);
