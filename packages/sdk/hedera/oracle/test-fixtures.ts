/** Deterministic fixtures for the oracle module tests. NOT exported from the package. */
import { keccak256, toUtf8Bytes } from "ethers";
import { NETWORKS } from "../networks";
import type { Hex } from "../hcs/envelope";
import type { AttestationDomain, NormalizeContext } from "./types";

export const TEST_ROUTER = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const DOMAIN: AttestationDomain = { chainId: NETWORKS.testnet.chainId, verifyingContract: TEST_ROUTER };
export const POLICY_ID = keccak256(toUtf8Bytes("policy.delivery.v1")) as Hex;
export const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");
export const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

export function baseContext(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    eventSource: keccak256(toUtf8Bytes("mock-oracle")) as Hex,
    policyId: POLICY_ID,
    validitySeconds: 900,
    ...overrides,
  };
}
