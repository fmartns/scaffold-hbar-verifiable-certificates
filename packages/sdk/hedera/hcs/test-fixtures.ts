/**
 * Deterministic fixtures for the HCS publisher tests. NOT exported from the package.
 * `TEST_SIGNER_KEY` is a throwaway key that exists only here and controls nothing; ECDSA signing is deterministic
 * (RFC 6979), so every signature below is stable across runs.
 */
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { NETWORKS } from "../networks";
import type { HederaNetworkName } from "../networks";
import { SETTLEMENT_EVENT_TYPES, eip712Domain } from "./envelope";
import type { SettlementEvent } from "./envelope";
import type { HcsPublisherConfig } from "./config";
import type { HcsTransport, TransportReceipt, TransportRequest } from "./publisher";

export const TEST_SIGNER_KEY = `0x${"01".repeat(32)}`;
export const TEST_SIGNER = new Wallet(TEST_SIGNER_KEY);
export const TEST_ROUTER = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const TEST_TOPIC = "0.0.4567";
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
export const FIXED_TX_ID = "0.0.1234@1767225600.123456789";
export const FIXED_CONSENSUS = "1767225605.987654321";

export const b32 = (label: string) => keccak256(toUtf8Bytes(label));

export function makeEvent(overrides: Partial<Record<keyof SettlementEvent, unknown>> = {}) {
  return {
    version: 1,
    eventSource: b32("mock-oracle"),
    externalEventId: b32("order-42:delivery.confirmed"),
    streamId: `0x${"00".repeat(32)}`,
    streamSeq: 0n,
    observedAt: 1_767_225_000n,
    validUntil: 1_767_225_600n,
    submitter: "0x0000000000000000000000000000000000000000",
    policyId: b32("policy.delivery.v1"),
    data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
    ...overrides,
  } as SettlementEvent;
}

export async function signEvent(event: SettlementEvent, router = TEST_ROUTER, chainId = 296): Promise<string> {
  return TEST_SIGNER.signTypedData(eip712Domain({ chainId, verifyingContract: router }), SETTLEMENT_EVENT_TYPES, event);
}

export function makeConfig(
  network: HederaNetworkName = "testnet",
  overrides: Partial<HcsPublisherConfig> = {},
): HcsPublisherConfig {
  return {
    network: NETWORKS[network],
    topicId: TEST_TOPIC,
    routerAddress: TEST_ROUTER,
    timeoutMs: 1_000,
    ...overrides,
  };
}

export function validEnv(extra: Record<string, string> = {}) {
  return {
    HEDERA_NETWORK: "testnet",
    HEDERA_HCS_TOPIC_ID: TEST_TOPIC,
    HEDERA_SETTLEMENT_ROUTER_ADDRESS: TEST_ROUTER,
    ...extra,
  };
}

export const goodReceipt = (overrides: Partial<TransportReceipt> = {}): TransportReceipt => ({
  transactionId: FIXED_TX_ID,
  sequenceNumber: "17",
  runningHash: "ab".repeat(48),
  consensusTimestamp: FIXED_CONSENSUS,
  ...overrides,
});

/** Fake transport: records every call, never touches the network. */
export function fakeTransport(behaviour: (request: TransportRequest) => Promise<TransportReceipt> | TransportReceipt) {
  const calls: TransportRequest[] = [];
  const transport: HcsTransport = {
    async submit(request) {
      calls.push(request);
      return behaviour(request);
    },
  };
  return { transport, calls };
}

/** Errors shaped like the Hedera SDK's, without importing it. */
export function hederaError(name: string, status?: string, message = "hedera error") {
  const error = new Error(message) as Error & { status?: { toString(): string } };
  error.name = name;
  if (status) error.status = { toString: () => status };
  return error;
}
