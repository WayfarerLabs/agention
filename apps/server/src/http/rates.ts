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
// budget has a token again, or a place is likely free, for the Retry-After
// header; what says what is exhausted, by default the requests.
export class RateLimitedError extends ApiError {
  readonly retryAfter: number;

  constructor(retryAfterMs: number, what = "too many requests") {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    super("rate_limited", `${what}; retry in ${retryAfter}s`);
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

  // full says whether the bucket has refilled to its burst by now, when it is
  // no different from a new one.
  full(now: number): boolean {
    const gained = Math.max(0, now - this.#updated) / this.#rate.interval;
    return this.#tokens + gained >= this.#rate.burst;
  }
}

// KeyedBudgets is a budget of one rate for each of many keys, each a full
// bucket on its first request. A bucket that has refilled is no different
// from a new one, so adding a key's bucket first drops every full one: the
// buckets held are only those of keys that spent within about the time a
// bucket takes to refill, however many keys there have ever been.
export class KeyedBudgets<K> {
  readonly #rate: Rate;
  readonly #buckets = new Map<K, TokenBucket>();

  constructor(rate: Rate) {
    this.#rate = rate;
  }

  // The buckets held now.
  get size(): number {
    return this.#buckets.size;
  }

  // spend takes a token from the key's bucket, or throws rate_limited.
  spend(key: K, now: number): void {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      for (const [each, held] of this.#buckets) {
        if (held.full(now)) {
          this.#buckets.delete(each);
        }
      }
      bucket = new TokenBucket(this.#rate, now);
      this.#buckets.set(key, bucket);
    }
    const wait = bucket.take(now);
    if (wait > 0) {
      throw new RateLimitedError(wait);
    }
  }
}

export class RateBudgets {
  readonly #clock: () => number;
  readonly #shared: Record<SharedBudget, TokenBucket>;
  readonly #keys: KeyedBudgets<string>;
  readonly #apiKeys: KeyedBudgets<number>;

  constructor(rates: Rates, clock: () => number) {
    this.#clock = clock;
    this.#keys = new KeyedBudgets(rates.key);
    this.#apiKeys = new KeyedBudgets(rates.apiKey);
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
  // budget.
  spendForKey(publicKey: string): void {
    this.#keys.spend(publicKey, this.#clock());
  }

  // spendForApiKey takes a token from a live API key's own budget, or throws
  // rate_limited. Only keys that authenticated get a budget.
  spendForApiKey(id: number): void {
    this.#apiKeys.spend(id, this.#clock());
  }
}
