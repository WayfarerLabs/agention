// One bridge acts for a session at a time, though a host may run several for
// it, all with its key: the latest to claim the session. Which one that is,
// and the number of the latest report it had accepted, lives in memory, since
// a bridge claims the session as its reporter starts and the claim matters
// only while bridges poll this process.

// What a request from a bridge does: the bridge acts for the session already
// ("holds"); it becomes the one that does ("takes"), by claiming the session
// or as the first bridge to call since the server started; or another acts
// for it and it does not claim it ("replaced").
export type Admission = "holds" | "takes" | "replaced";

// BridgeHolders keeps, for each session, the bridge that acts for it and the
// number of the latest report accepted from it. Its callers decide with
// admission and newer, write what the request changes, and only then record
// the change with hold, so a write that fails leaves the holder as it was.
export class BridgeHolders {
  readonly #holders = new Map<number, { bridge: string; seq: number }>();

  // admission says what a request from a bridge does, changing nothing.
  admission(sessionId: number, bridge: string, claim: boolean): Admission {
    const holder = this.#holders.get(sessionId);
    if (holder?.bridge === bridge) {
      return "holds";
    }
    return holder === undefined || claim ? "takes" : "replaced";
  }

  // newer says whether a report numbered seq from the bridge that acts for
  // the session comes after the latest accepted from it.
  newer(sessionId: number, seq: number): boolean {
    return seq > (this.#holders.get(sessionId)?.seq ?? 0);
  }

  // hold records the bridge as the one that acts for the session, with the
  // number of the latest report accepted from it: seq for a report, and
  // otherwise what it was for the same bridge, or none for one taking over.
  hold(sessionId: number, bridge: string, seq?: number): void {
    const holder = this.#holders.get(sessionId);
    const latest = holder?.bridge === bridge ? holder.seq : 0;
    this.#holders.set(sessionId, { bridge, seq: seq ?? latest });
  }

  // forget drops the session's holder, as when one of its credentials is
  // revoked, so the map holds no bridge that can no longer call; the next
  // bridge to call for the session takes it, and none is replaced meanwhile.
  forget(sessionId: number): void {
    this.#holders.delete(sessionId);
  }
}
