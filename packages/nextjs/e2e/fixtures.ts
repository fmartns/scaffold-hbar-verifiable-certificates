import { test as base, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

/**
 * Deterministic fixtures for the public verifier's E2E lifecycle test. These mirror the shapes the console API
 * routes (`GET /api/credentials/status`, `GET /api/credentials/audit`) actually return — see
 * `packages/sdk/hedera/credentials/issuer-flow.ts` (`CredentialStatusView`) and `packages/sdk/hedera/audit/types.ts`
 * (`CredentialAuditReport`) — kept in sync with the Vitest fixtures in
 * `app/issuer/_components/test-utils.tsx` (`auditReport`). The point of mocking at the HTTP boundary rather than
 * the SDK is that these tests exercise the real browser bundle (`createVerifierBackend` → `fetch`) without needing
 * a configured Hedera network or credentials, exactly the constraint called out in AGENTS.md for external
 * integrations ("an interface, timeout, validation and deterministic test fixture").
 */

export const CREDENTIAL_ID = `0x${"11".repeat(32)}`;
export const REVOKED_CREDENTIAL_ID = `0x${"22".repeat(32)}`;
export const UNKNOWN_CREDENTIAL_ID = `0x${"33".repeat(32)}`;

const ISSUER = `0x${"aa".repeat(32)}`;
const SIGNER = `0x${"bb".repeat(20)}`;
const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const TX_HASH = `0x${"ab".repeat(32)}`;

type Envelope = { ok: true; value: unknown } | { ok: false; error: unknown };

function statusView(status: "issued" | "revoked" | "not_found", credentialId: string) {
  return {
    credentialId,
    status,
    issuer: ISSUER,
    signer: SIGNER,
    issuedAt: status === "not_found" ? "0" : "1790000000",
    revokedAt: status === "revoked" ? "1790500000" : "0",
  };
}

function auditReport(credentialId: string) {
  return {
    credentialId,
    subject: { kind: "credential" },
    onChain: { status: "issued", record: null },
    evidence: "consistent",
    issuance: {
      hcs: null,
      onChain: {
        transactionHash: TX_HASH,
        consensusTimestamp: "1790000005.000000001",
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000005.000000001",
        signer: SIGNER,
        attestationDigest: `0x${"22".repeat(32)}`,
        schemaId: `0x${"55".repeat(32)}`,
        hcsSequence: "42",
        hcsConsensusTimestampNs: "1790000001000000002",
      },
      matched: true,
    },
    revocation: null,
    timeline: [
      {
        step: "hcs.issuance",
        consensusTimestamp: "1790000001.000000002",
        reference: "0.0.4567#42",
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000001.000000002",
      },
      {
        step: "chain.issued",
        consensusTimestamp: "1790000005.000000001",
        reference: TX_HASH,
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000005.000000001",
      },
    ],
    findings: [],
    provenance: {
      network: "testnet",
      mirrorNode: "https://testnet.mirrornode.hedera.com",
      rpc: "https://testnet.hashio.io",
      registryAddress: REGISTRY,
      topicId: "0.0.4567",
      queriedAt: "2026-10-01T12:00:10.000Z",
      highestConsensusTimestampSeen: "1790000005.000000001",
    },
  };
}

async function fulfillJson(route: Route, body: Envelope, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/**
 * Intercepts the two read-only console API routes the verifier calls and answers them deterministically for the
 * given `credentialId`, as if `status` were its on-chain record. Any other `credentialId` requested through the
 * same page falls back to `not_found`, so a test can also exercise the "no such credential" path without a second
 * mock installation.
 */
export async function mockCredentialApi(page: Page, credentialId: string, status: "issued" | "revoked" | "not_found") {
  await page.route("**/api/credentials/status*", async route => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("credentialId") ?? "";
    const view = id === credentialId ? statusView(status, id) : statusView("not_found", id);
    await fulfillJson(route, { ok: true, value: view });
  });

  await page.route("**/api/credentials/audit*", async route => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get("credentialId") ?? "";
    await fulfillJson(route, { ok: true, value: auditReport(id) });
  });
}

export const test = base;
export { expect };
