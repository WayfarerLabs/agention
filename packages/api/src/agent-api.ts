import { z } from "zod";

// The agent API's version. Every request the bridge makes, and every answer
// on the server's agent mount, states in agentApiHeader the version its
// sender speaks; a missing one means 1, the version of every bridge and server
// released before the header. version is the one this release speaks. The
// server serves every version from oldest to version, and the bridge refuses
// an answer from a server older than itself, so a mismatch fails loudly
// before a field goes missing unnoticed. Every change to the agent contract,
// a new route or a new field on one, bumps version by one; oldest moves only
// by the operator's decision.
export const agentApi = { version: 5, oldest: 1 } as const;

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
