/**
 * Identity helpers of ADR-001 §4.4 (rules R1–R6). Every `OracleProvider` — mock or real (#23) — MUST derive
 * `externalEventId` this way: a deterministic function of the fields that identify the event, and of nothing else
 * (never `observedAt`, a price at read time, a transport id, or an HCS sequence).
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { AbiCoder } from "ethers";
import type { Hex } from "../hcs/envelope";

const coder = AbiCoder.defaultAbiCoder();

/** R6: `eventSource = keccak256(bytes(<lowercase ASCII source name>))`. Registered in the router (ADR §4.5). */
export function eventSourceOf(name: string): Hex {
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error("eventSourceOf: name must be printable ASCII");
  return keccak256(toUtf8Bytes(name.toLowerCase())) as Hex;
}

/**
 * R4: when the provider has its own native unique id, hash it (optionally namespaced by an event type, R5, when one
 * source emits several kinds of event for one entity). R4 also requires never hashing JSON (canonicalization ambiguity):
 * pass identity fields as plain strings, not a serialized object.
 */
export function externalEventIdFromRef(providerRef: string, eventType?: string): Hex {
  return eventType
    ? (keccak256(coder.encode(["string", "string"], [eventType, providerRef])) as Hex)
    : (keccak256(toUtf8Bytes(providerRef)) as Hex);
}

/** R6 for on-chain feed providers: `externalEventId = keccak256(abi.encode(feedId, roundId))`. */
export function externalEventIdFromFeedRound(feedId: string, roundId: bigint | number): Hex {
  return keccak256(coder.encode(["string", "uint256"], [feedId, roundId])) as Hex;
}

/**
 * R1–R4 fallback: when a provider has no native id, hash a fixed tuple of the fields that identify the event (never the
 * whole raw payload, and never JSON — R4).
 */
export function externalEventIdFromFields(fields: (string | number | bigint)[]): Hex {
  return keccak256(
    coder.encode(
      fields.map(f => (typeof f === "string" ? "string" : "uint256")),
      fields,
    ),
  ) as Hex;
}
