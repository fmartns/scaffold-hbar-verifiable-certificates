/**
 * Reference `EventNormalizer` (ADR §6.9, §8 "#8"). Pure: no clock, no I/O, no randomness. Used by the mock and available
 * to any real provider (#23) whose raw shape fits its conventions; a provider with richer facts may supply its own
 * normalizer instead — the contract is the `EventNormalizer` interface in `./types`, not this specific function.
 *
 * Conventions this normalizer requires (documented for #23):
 *  - `raw.providerRef` is REQUIRED: without a native id there is no field left, after excluding volatile ones (R3), to
 *    build a stable identity from. A provider with no native id must synthesize one from ITS OWN stable identity fields
 *    (ADR R1: "a deterministic function of the fields that identify the event, and of nothing else").
 *  - `raw.data` is either already-encoded bytes (`` `0x${string}` ``, used as-is — the recommended path for anything
 *    beyond a single amount), a `bigint`/safe `number` (encoded as `abi.encode(["uint256"], [value])`), or absent
 *    (encoded as empty `0x`). The normalizer never inspects or reinterprets it: policy-specific facts are the policy's
 *    concern (ADR §6.1), not the oracle's.
 */
import { AbiCoder, isHexString } from "ethers";
import type { Hex } from "../hcs/envelope";
import { MAX_DATA_LEN } from "../hcs/envelope";
import { externalEventIdFromRef } from "./identity";
import type { EventNormalizer, NormalizeContext, NormalizeIssue, NormalizeResult, RawObservation } from "./types";

const ZERO_HEX32 = `0x${"00".repeat(32)}` as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const coder = AbiCoder.defaultAbiCoder();

function encodeData(data: RawObservation["data"], issues: NormalizeIssue[]): Hex {
  if (data === undefined || data === null) return "0x";
  if (typeof data === "string") {
    if (!isHexString(data) || (data.length - 2) % 2 !== 0) {
      issues.push({
        field: "data",
        message: "data must be a hex string with an even number of digits, or a number/bigint.",
      });
      return "0x";
    }
    return data.toLowerCase() as Hex;
  }
  if (typeof data === "bigint" || (typeof data === "number" && Number.isSafeInteger(data))) {
    if (data < 0) {
      issues.push({ field: "data", message: "a numeric data value must not be negative." });
      return "0x";
    }
    return coder.encode(["uint256"], [data]) as Hex;
  }
  issues.push({ field: "data", message: "data must be a hex string, a bigint, a safe integer, or omitted." });
  return "0x";
}

export function normalizeObservation(raw: RawObservation, ctx: NormalizeContext): NormalizeResult {
  const issues: NormalizeIssue[] = [];

  if (!raw.providerRef) {
    issues.push({
      field: "providerRef",
      message:
        "raw.providerRef is required: the reference normalizer needs a stable native id to derive externalEventId (ADR R1-R6). A provider without one must synthesize a stable providerRef itself.",
    });
  }
  if (!Number.isFinite(raw.observedAt) || raw.observedAt < 0 || !Number.isSafeInteger(raw.observedAt)) {
    issues.push({ field: "observedAt", message: "raw.observedAt must be a non-negative safe integer (unix seconds)." });
  }
  if (!ctx.policyId || ctx.policyId === ZERO_HEX32) {
    issues.push({ field: "policyId", message: "ctx.policyId must be a non-zero 32-byte value." });
  }
  const streamId = ctx.streamId ?? ZERO_HEX32;
  const streamSeq = ctx.streamSeq ?? 0n;
  if (streamId === ZERO_HEX32 && streamSeq !== 0n) {
    issues.push({ field: "streamSeq", message: "ctx.streamSeq must be 0 when ctx.streamId is unset (ADR §4.9)." });
  }
  if (streamId !== ZERO_HEX32 && streamSeq === 0n) {
    issues.push({ field: "streamSeq", message: "ctx.streamSeq must be >= 1 when ctx.streamId is set (ADR §4.9)." });
  }
  if (!Number.isFinite(ctx.validitySeconds) || ctx.validitySeconds <= 0) {
    issues.push({ field: "validitySeconds", message: "ctx.validitySeconds must be a positive number of seconds." });
  }

  const data = encodeData(raw.data, issues);
  if ((data.length - 2) / 2 > MAX_DATA_LEN) {
    issues.push({
      field: "data",
      message: `data is ${(data.length - 2) / 2} bytes; the maximum is ${MAX_DATA_LEN} (ADR §6.2).`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  const observedAt = BigInt(raw.observedAt);
  return {
    ok: true,
    value: {
      version: 1,
      eventSource: ctx.eventSource,
      externalEventId: externalEventIdFromRef(raw.providerRef as string, raw.eventType),
      streamId,
      streamSeq,
      observedAt,
      validUntil: observedAt + BigInt(Math.floor(ctx.validitySeconds)),
      submitter: ctx.submitter ?? ZERO_ADDRESS,
      policyId: ctx.policyId,
      data,
    },
  };
}

/** The reference normalizer as an `EventNormalizer`. */
export const defaultNormalizer: EventNormalizer = { normalize: normalizeObservation };
