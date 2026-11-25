// One bridge acts for a session at a time, though a host may run several for
// it, all with its key: the latest to claim the session. Which one that is
// lives in memory, since a bridge claims the session as its reporter starts
// and the claim matters only while bridges poll this process.

// BridgeHolders keeps, for each session, the id of the bridge that acts for
// it.
export class BridgeHolders {
  readonly #holders = new Map<number, string>();

  // admit says whether a request from a bridge acts for the session, making
  // it the one that does when it claims the session or when none does yet,
  // as after the server starts. It answers "took" when the bridge claimed the
  // session from another, whose open poll its caller then wakes to learn it
  // was replaced.
  admit(sessionId: number, bridge: string, claim: boolean): "holds" | "took" | "replaced" {
    const holder = this.#holders.get(sessionId);
    if (holder === bridge) {
      return "holds";
    }
    if (holder !== undefined && !claim) {
      return "replaced";
    }
    this.#holders.set(sessionId, bridge);
    return holder === undefined ? "holds" : "took";
  }

  // holds says whether the bridge still acts for the session.
  holds(sessionId: number, bridge: string): boolean {
    return this.#holders.get(sessionId) === bridge;
  }
}
