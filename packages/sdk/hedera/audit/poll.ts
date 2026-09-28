/**
 * Polling with exponential backoff and an overall deadline, for reads against the eventually consistent Mirror Node
 * (ADR-001 §3.8, D10). A read that returns nothing is retried until the deadline; it is never taken as proof of absence.
 * Clock and sleep are injectable so the behaviour is tested deterministically.
 */
import { MirrorReadError } from "./mirror";

export interface PollOptions {
  /** Overall deadline of the poll, in milliseconds. `0` = a single attempt. */
  timeoutMs: number;
  /** Delay before the second attempt. Default 500 ms. */
  initialDelayMs?: number;
  /** Upper bound of one delay. Default 5000 ms. */
  maxDelayMs?: number;
  /** Growth of the delay between attempts. Default 2. */
  factor?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type PollResult<T> =
  | { found: true; value: T; attempts: number; elapsedMs: number }
  | { found: false; attempts: number; elapsedMs: number };

export const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Calls `probe` until it returns a value (not `null`/`undefined`) or the deadline passes. A retryable
 * `MirrorReadError` (network, 5xx, 429) counts as "not yet"; if the deadline passes while the Mirror Node is still
 * failing, the last such error is thrown so the caller reports "unavailable", not "missing". Any other error is thrown
 * immediately.
 */
export async function pollUntilFound<T>(
  probe: () => Promise<T | null | undefined>,
  options: PollOptions,
): Promise<PollResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const factor = options.factor ?? 2;
  const maxDelay = options.maxDelayMs ?? 5_000;
  const started = now();
  let delay = options.initialDelayMs ?? 500;
  let attempts = 0;

  for (;;) {
    attempts++;
    let lastError: MirrorReadError | null = null;
    try {
      const value = await probe();
      if (value !== null && value !== undefined) return { found: true, value, attempts, elapsedMs: now() - started };
    } catch (error) {
      if (!(error instanceof MirrorReadError) || !error.retryable) throw error;
      lastError = error;
    }
    const elapsed = now() - started;
    const remaining = options.timeoutMs - elapsed;
    if (remaining <= 0) {
      if (lastError) throw lastError;
      return { found: false, attempts, elapsedMs: elapsed };
    }
    await sleep(Math.min(delay, maxDelay, remaining));
    delay = Math.min(delay * factor, maxDelay);
  }
}
