import { ApiError } from "../errors.ts";

// Rate budgets keep any one kind of traffic from starving the others. None is
// keyed on the source address, which behind a proxy such as tailscale serve is
// the same for everyone and which Agention never trusts. Requests signed by a
// key the server knows, and requests carrying a live API key, spend that key's
// own budget; everything else spends one budget shared by its class. Every
// shared budget but the submit budget is spent only by requests that fail,
// after they have been checked, so draining one never refuses a valid key,
// passkey or link.

// A token bucket's shape: it holds up to burst tokens and gains one every
// interval milliseconds; each request spends one.
export interface Rate {
  burst: number;
  interval: number;
}

export interface Rates {
  // Each registered key's requests: its registration checks while pending,
  // and its session's calls once approved.
  key: Rate;
  // Each API key's requests on the operator mount.
  apiKey: Rate;
  // Registration requests that submit a key the server has not seen.
  submit: Rate;
  // Agent requests that fail authentication: no token, an unknown key, a bad
  // signature or claims, or a session call from a key that is not approved.
  failedAgentAuth: Rate;
  // Operator mount requests that fail authentication: no API key, or one that
  // is malformed, unknown, revoked or expired.
  failedKeyAuth: Rate;
  // Passkey sign-ins that fail at their finish.
  failedSignIn: Rate;
  // Passkey links that fail: a bad link at begin, or a failed finish.
  failedLink: Rate;
}

export const defaultRates: Rates = {
  key: { burst: 60, interval: 1000 },
  apiKey: { burst: 60, interval: 1000 },
  submit: { burst: 20, interval: 30_000 },
  failedAgentAuth: { burst: 60, interval: 1000 },
  failedKeyAuth: { burst: 60, interval: 1000 },
  failedSignIn: { burst: 20, interval: 6000 },
  failedLink: { burst: 20, interval: 6000 },
};

export type SharedBudget = Exclude<keyof Rates, "key" | "apiKey">;

// RateLimitedError is the rate_limited error, with the seconds until the
// budget has a token again for the Retry-After header.
export class RateLimitedError extends ApiError {
  readonly retryAfter: number;

  constructor(retryAfterMs: number) {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super("rate_limited", `too many requests; retry in ${retryAfter} seconds`);
    this.retryAfter = retryAfter;
  }
}

export class TokenBucket {
  readonly #rate: Rate;
  #tokens: number;
  #updated: number;

  constructor(rate: Rate, now: number) {
    this.#rate = rate;
    this.#tokens = rate.burst;
    this.#updated = now;
  }

  // take spends a token and returns 0, or, when the bucket is empty, returns
  // the milliseconds until it holds one.
  take(now: number): number {
    const gained = Math.max(0, now - this.#updated) / this.#rate.interval;
    this.#tokens = Math.min(this.#rate.burst, this.#tokens + gained);
    this.#updated = now;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.#tokens) * this.#rate.interval);
  }
}

export class RateBudgets {
  readonly #rates: Rates;
  readonly #clock: () => number;
  readonly #shared: Record<SharedBudget, TokenBucket>;
  readonly #keys = new Map<string, TokenBucket>();
  readonly #apiKeys = new Map<number, TokenBucket>();

  constructor(rates: Rates, clock: () => number) {
    this.#rates = rates;
    this.#clock = clock;
    const now = clock();
    this.#shared = {
      submit: new TokenBucket(rates.submit, now),
      failedAgentAuth: new TokenBucket(rates.failedAgentAuth, now),
      failedKeyAuth: new TokenBucket(rates.failedKeyAuth, now),
      failedSignIn: new TokenBucket(rates.failedSignIn, now),
      failedLink: new TokenBucket(rates.failedLink, now),
    };
  }

  // spend takes a token from a shared budget, or throws rate_limited.
  spend(budget: SharedBudget): void {
    const wait = this.#shared[budget].take(this.#clock());
    if (wait > 0) {
      throw new RateLimitedError(wait);
    }
  }

  // spendOnFailure runs an attempt and, when it fails as unauthenticated,
  // spends a token from the budget, answering rate_limited instead once the
  // budget is exhausted. A successful attempt spends nothing.
  async spendOnFailure<T>(budget: SharedBudget, attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthenticated") {
        this.spend(budget);
      }
      throw error;
    }
  }

  // spendForKey takes a token from a registered key's own budget, or throws
  // rate_limited. Only keys the server has had a registration for get a
  // budget, so the map grows no faster than the submit budget lets new keys
  // register.
  spendForKey(publicKey: string): void {
    spendFrom(this.#keys, publicKey, this.#rates.key, this.#clock());
  }

  // spendForApiKey takes a token from a live API key's own budget, or throws
  // rate_limited. Only keys that authenticated get a budget, so the map grows
  // no faster than the operator creates keys.
  spendForApiKey(id: number): void {
    spendFrom(this.#apiKeys, id, this.#rates.apiKey, this.#clock());
  }
}

// spendFrom takes a token from the bucket of one key among many, giving the
// key a full bucket of the rate on its first request.
function spendFrom<K>(buckets: Map<K, TokenBucket>, key: K, rate: Rate, now: number): void {
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = new TokenBucket(rate, now);
    buckets.set(key, bucket);
  }
  const wait = bucket.take(now);
  if (wait > 0) {
    throw new RateLimitedError(wait);
  }
}
