import { describe, expect, it } from "vitest";
import { MirrorReadError } from "./mirror";
import { pollUntilFound } from "./poll";
import { virtualClock } from "./test-fixtures";

describe("pollUntilFound", () => {
  it("returns on the first attempt when the data is already indexed", async () => {
    const clock = virtualClock(0);
    const result = await pollUntilFound(async () => "row", { timeoutMs: 5_000, ...clock });
    expect(result).toEqual({ found: true, value: "row", attempts: 1, elapsedMs: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  it("retries with exponential backoff until the data appears", async () => {
    const clock = virtualClock(0);
    let calls = 0;
    const result = await pollUntilFound(async () => (++calls >= 4 ? "row" : null), {
      timeoutMs: 60_000,
      initialDelayMs: 500,
      ...clock,
    });
    expect(result).toMatchObject({ found: true, value: "row", attempts: 4 });
    expect(clock.sleeps).toEqual([500, 1_000, 2_000]);
  });

  it("caps each delay and never sleeps past the deadline", async () => {
    const clock = virtualClock(0);
    const result = await pollUntilFound(async () => null, {
      timeoutMs: 10_000,
      initialDelayMs: 1_000,
      maxDelayMs: 3_000,
      ...clock,
    });
    expect(result).toEqual({ found: false, attempts: 6, elapsedMs: 10_000 });
    expect(clock.sleeps).toEqual([1_000, 2_000, 3_000, 3_000, 1_000]);
  });

  it("makes a single attempt with a zero timeout", async () => {
    const clock = virtualClock(0);
    expect(await pollUntilFound(async () => null, { timeoutMs: 0, ...clock })).toEqual({
      found: false,
      attempts: 1,
      elapsedMs: 0,
    });
  });

  it("treats a retryable Mirror error as 'not yet' and recovers", async () => {
    const clock = virtualClock(0);
    let calls = 0;
    const result = await pollUntilFound(
      async () => {
        if (++calls === 1) throw new MirrorReadError("MIRROR_UNAVAILABLE", "HTTP 503", true);
        return "row";
      },
      { timeoutMs: 5_000, ...clock },
    );
    expect(result).toMatchObject({ found: true, attempts: 2 });
  });

  it("rethrows the last retryable error if the Mirror Node is still failing at the deadline", async () => {
    const clock = virtualClock(0);
    await expect(
      pollUntilFound(
        async () => {
          throw new MirrorReadError("MIRROR_UNAVAILABLE", "HTTP 503", true);
        },
        { timeoutMs: 2_000, ...clock },
      ),
    ).rejects.toMatchObject({ code: "MIRROR_UNAVAILABLE" });
  });

  it("throws non-retryable errors immediately", async () => {
    const clock = virtualClock(0);
    let calls = 0;
    await expect(
      pollUntilFound(
        async () => {
          calls++;
          throw new MirrorReadError("MIRROR_MALFORMED", "bad json", false);
        },
        { timeoutMs: 5_000, ...clock },
      ),
    ).rejects.toMatchObject({ code: "MIRROR_MALFORMED" });
    expect(calls).toBe(1);
  });
});
