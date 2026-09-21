/**
 * Identifiers for a settlement created BY HAND (`yarn hts:settle`), for manual testing of this adapter outside the real
 * oracle -> HCS -> router flow. These are NOT the ADR's identity computation: a real settlement's `eventKey`,
 * `settlementId` and `contentHash` come from `hedera/hcs/envelope.ts`, derived from the oracle's `eventSource` and
 * `externalEventId` (ADR-001 §4.3). Use `settlementInputFromEnvelope` for that. This module exists only so a person can
 * run one settlement from the command line and reuse or vary the identity on purpose (to test idempotency or a conflict).
 */
import { keccak256, toUtf8Bytes } from "ethers";
import type { Hex } from "../hcs/envelope";

export interface ManualSettlementIdentifiers {
  eventKey: Hex;
  settlementId: Hex;
  contentHash: Hex;
  /** The label the identifiers were derived from, or a generated one when none was given. */
  label: string;
}

/**
 * Deterministic given a `label`: the same label (with the same token, beneficiary and amount) always yields the same
 * `eventKey`, so running the command again is a deliberate idempotency test. Without a label, a fresh one is generated
 * from the clock so two runs never collide by accident; the caller should show it so it can be reused on purpose.
 */
export function manualSettlementIdentifiers(input: {
  label?: string;
  tokenId: string;
  beneficiary: string;
  amount: bigint;
  now?: () => number;
}): ManualSettlementIdentifiers {
  const label = input.label ?? `cli-${(input.now ?? Date.now)()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    eventKey: keccak256(toUtf8Bytes(`hvs-cli.event:${label}`)) as Hex,
    settlementId: keccak256(toUtf8Bytes(`hvs-cli.settlement:${label}`)) as Hex,
    contentHash: keccak256(
      toUtf8Bytes(`hvs-cli.content:${label}:${input.tokenId}:${input.beneficiary}:${input.amount}`),
    ) as Hex,
    label,
  };
}
