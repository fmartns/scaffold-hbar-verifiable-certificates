import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_REVOCATION_TYPES,
  decodeCredentialMessage,
} from "../hcs/credential-envelope";
import { buildCredentialDraft, buildRevocationDraft } from "./fields";
import {
  handleCredentialAudit,
  handleCredentialStatus,
  handlePublishCredential,
  issuerConsoleSettings,
} from "./server";
import { serializeCredentialEvent, serializeCredentialRevocation } from "./signing";
import {
  CHAIN_ID,
  DRAFT_INPUT,
  ENV,
  ISSUER_ADDRESS,
  NOW_MS,
  OTHER_WALLET,
  REGISTRY_ADDRESS,
  fakeRelay,
  fakeTransport,
  signEvent,
} from "./issuer-test-fixtures";

const draft = buildCredentialDraft(DRAFT_INPUT, {
  nowSeconds: NOW_MS / 1000,
  submitter: ISSUER_ADDRESS,
  salt: `0x${"5a".repeat(32)}`,
});
if (!draft.ok) throw new Error("draft failed");
const { event, credentialId } = draft.value;
const ACTIVE = { [event.issuer]: { signer: ISSUER_ADDRESS, active: true } };

async function issuanceBody(wallet = undefined as Parameters<typeof signEvent>[2]) {
  return {
    kind: "issuance",
    event: serializeCredentialEvent(event),
    signature: await signEvent(event as never, CREDENTIAL_EVENT_TYPES, wallet),
  };
}

describe("handlePublishCredential", () => {
  it("publishes a message signed by the active issuer's signer and returns the consensus receipt", async () => {
    const relay = fakeRelay({ issuers: ACTIVE });
    const { transport, submitted } = fakeTransport();
    const response = await handlePublishCredential(await issuanceBody(), {
      env: ENV,
      fetch: relay.fetch,
      transport,
      now: () => new Date(NOW_MS),
    });
    expect(response.status).toBe(200);
    if (!response.body.ok) throw new Error(response.body.error.message);
    const receipt = response.body.value;
    expect(receipt).toMatchObject({
      kind: "issuance",
      credentialId,
      signer: ISSUER_ADDRESS,
      transactionId: "0.0.1001@1790000000.000000001",
      hcsRef: { sequence: "42", consensusTimestampNs: "1790000001000000002" },
      hashscanUrl: "https://hashscan.io/testnet/transaction/1790000001.000000002",
    });
    // The published bytes are the canonical credential envelope, parsed back by its only parser.
    const decoded = decodeCredentialMessage(submitted[0], { chainId: CHAIN_ID, verifyingContract: REGISTRY_ADDRESS });
    expect(decoded.ok && decoded.value.derived.credentialId).toBe(credentialId);
  });

  it("refuses to make an unpinned issuance (submitter = 0) public: it could be front-run with a forged HcsRef", async () => {
    const unpinned = { ...event, submitter: "0x0000000000000000000000000000000000000000" as const };
    const relay = fakeRelay({ issuers: ACTIVE });
    const { transport, submitted } = fakeTransport();
    const response = await handlePublishCredential(
      {
        kind: "issuance",
        event: serializeCredentialEvent(unpinned),
        signature: await signEvent(unpinned as never, CREDENTIAL_EVENT_TYPES),
      },
      { env: ENV, fetch: relay.fetch, transport },
    );
    expect(response.status).toBe(400);
    expect(!response.body.ok && response.body.error).toMatchObject({
      category: "invalid_input",
      code: "SUBMITTER_NOT_PINNED",
    });
    expect(relay.calls).toHaveLength(0);
    expect(submitted).toHaveLength(0);
  });

  it("refuses an unregistered issuer with 403 before publishing anything", async () => {
    const { transport, submitted } = fakeTransport();
    const response = await handlePublishCredential(await issuanceBody(), {
      env: ENV,
      fetch: fakeRelay({}).fetch,
      transport,
    });
    expect(response.status).toBe(403);
    expect(!response.body.ok && response.body.error).toMatchObject({
      category: "issuer_not_registered",
      code: "UnknownIssuer",
    });
    expect(submitted).toHaveLength(0);
  });

  it("refuses a deactivated issuer and a signer that is not the registered one", async () => {
    const inactive = await handlePublishCredential(await issuanceBody(), {
      env: ENV,
      fetch: fakeRelay({ issuers: { [event.issuer]: { signer: ISSUER_ADDRESS, active: false } } }).fetch,
      transport: fakeTransport().transport,
    });
    expect(!inactive.body.ok && inactive.body.error.code).toBe("InactiveIssuer");
    const stranger = await handlePublishCredential(await issuanceBody(OTHER_WALLET), {
      env: ENV,
      fetch: fakeRelay({ issuers: ACTIVE }).fetch,
      transport: fakeTransport().transport,
    });
    expect(!stranger.body.ok && stranger.body.error.code).toBe("UnauthorizedSigner");
  });

  it("rejects malformed requests with per-field issues", async () => {
    const response = await handlePublishCredential(
      { kind: "issuance", event: { ...serializeCredentialEvent(event), credentialHash: "0x12" }, signature: "0x" },
      { env: ENV, fetch: fakeRelay({}).fetch, transport: fakeTransport().transport },
    );
    expect(response.status).toBe(400);
    expect(!response.body.ok && response.body.error.issues?.map(i => i.field)).toEqual(
      expect.arrayContaining(["credentialHash", "signature"]),
    );
    expect((await handlePublishCredential(null, { env: ENV })).status).toBe(400);
  });

  it("answers 503 not_configured, naming the variables but no secret", async () => {
    const response = await handlePublishCredential(await issuanceBody(), {
      env: { HEDERA_OPERATOR_KEY: "super-secret-key" },
    });
    expect(response.status).toBe(503);
    if (response.body.ok) throw new Error("expected failure");
    expect(response.body.error.category).toBe("not_configured");
    expect(response.body.error.remediation).toContain("HEDERA_CREDENTIAL_REGISTRY_ADDRESS");
    expect(JSON.stringify(response.body)).not.toContain("super-secret-key");
  });

  it("answers 502 rpc_unavailable when the relay is down, without publishing", async () => {
    const { transport, submitted } = fakeTransport();
    const response = await handlePublishCredential(await issuanceBody(), {
      env: ENV,
      fetch: fakeRelay({ down: true }).fetch,
      transport,
    });
    expect(response.status).toBe(502);
    expect(!response.body.ok && response.body.error.category).toBe("rpc_unavailable");
    expect(submitted).toHaveLength(0);
  });

  it("maps HCS failures: Hedera status (502) and timeout (504) with the transaction id", async () => {
    const hederaError = Object.assign(new Error("receipt"), {
      name: "ReceiptStatusError",
      status: { toString: () => "INSUFFICIENT_PAYER_BALANCE" },
    });
    const hedera = await handlePublishCredential(await issuanceBody(), {
      env: ENV,
      fetch: fakeRelay({ issuers: ACTIVE }).fetch,
      transport: fakeTransport(hederaError).transport,
    });
    expect(hedera.status).toBe(502);
    expect(!hedera.body.ok && hedera.body.error).toMatchObject({
      category: "hedera",
      hederaStatus: "INSUFFICIENT_PAYER_BALANCE",
    });

    const timeout = await handlePublishCredential(await issuanceBody(), {
      env: { ...ENV, HEDERA_HCS_PUBLISH_TIMEOUT_MS: "1000" },
      fetch: fakeRelay({ issuers: ACTIVE }).fetch,
      transport: { submit: req => (req.onTransactionId("0.0.1001@1.1"), new Promise(() => undefined)) },
    });
    expect(timeout.status).toBe(504);
    expect(!timeout.body.ok && timeout.body.error).toMatchObject({
      category: "timeout",
      transactionId: "0.0.1001@1.1",
    });
  });

  it("publishes a revocation only for an issued credential, signed by its issuer's signer", async () => {
    const revocation = buildRevocationDraft({
      credentialId,
      issuer: event.issuer,
      reason: "superseded",
      nowSeconds: NOW_MS / 1000,
    });
    if (!revocation.ok) throw new Error("revocation failed");
    const body = {
      kind: "revocation",
      revocation: serializeCredentialRevocation(revocation.value),
      signature: await signEvent(revocation.value as never, CREDENTIAL_REVOCATION_TYPES),
    };
    const records = { [credentialId]: { status: 1 as const, issuer: event.issuer } };
    const ok = await handlePublishCredential(body, {
      env: ENV,
      fetch: fakeRelay({ issuers: ACTIVE, records }).fetch,
      transport: fakeTransport().transport,
    });
    expect(ok.status).toBe(200);

    const revoked = await handlePublishCredential(body, {
      env: ENV,
      fetch: fakeRelay({ issuers: ACTIVE, records: { [credentialId]: { ...records[credentialId], status: 2 } } }).fetch,
      transport: fakeTransport().transport,
    });
    expect(!revoked.body.ok && revoked.body.error.code).toBe("AlreadyRevoked");

    const missing = await handlePublishCredential(body, {
      env: ENV,
      fetch: fakeRelay({ issuers: ACTIVE }).fetch,
      transport: fakeTransport().transport,
    });
    expect(!missing.body.ok && missing.body.error.code).toBe("UnknownCredential");
  });
});

describe("status, audit and settings", () => {
  it("reads statusOf as JSON-safe strings", async () => {
    const response = await handleCredentialStatus(credentialId, {
      env: { ...ENV, HEDERA_OPERATOR_KEY: "" },
      fetch: fakeRelay({ records: { [credentialId]: { status: 1, issuer: event.issuer } } }).fetch,
    });
    expect(response.body).toEqual({
      ok: true,
      value: expect.objectContaining({ credentialId, status: "issued", issuer: event.issuer, issuedAt: "1790000000" }),
    });
    expect((await handleCredentialStatus("0x12", { env: ENV })).status).toBe(400);
  });

  it("returns the shared audit report with bigints as strings", async () => {
    const response = await handleCredentialAudit(credentialId, {
      env: ENV,
      fetch: fakeRelay({}).fetch,
      pollTimeoutMs: 0,
    });
    expect(response.status).toBe(200);
    expect(response.body.ok && response.body.value).toMatchObject({
      credentialId,
      onChain: { status: "not_found" },
      evidence: "not_applicable",
    });
  });

  it("gives the browser public identifiers only", () => {
    const settings = issuerConsoleSettings(ENV);
    expect(settings).toEqual({
      configured: true,
      issues: [],
      network: "testnet",
      chainId: CHAIN_ID,
      registryAddress: REGISTRY_ADDRESS,
      topicId: "0.0.4567",
      hashscanUrl: "https://hashscan.io/testnet",
    });
    expect(JSON.stringify(settings)).not.toContain(ENV.HEDERA_OPERATOR_KEY);
    const missing = issuerConsoleSettings({});
    expect(missing.configured).toBe(false);
    expect(missing.issues.map(i => i.variable)).toEqual(
      expect.arrayContaining(["HEDERA_HCS_TOPIC_ID", "HEDERA_CREDENTIAL_REGISTRY_ADDRESS", "HEDERA_OPERATOR_ID"]),
    );
  });
});
