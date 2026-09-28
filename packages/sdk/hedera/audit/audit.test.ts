import { describe, expect, it } from "vitest";
import { id } from "ethers";
import { auditCredential, auditHcsMessage } from "./audit";
import type { CredentialAuditReport } from "./types";
import {
  ADMIN,
  CREDENTIAL_ID,
  HCS_ISSUANCE_TS,
  HCS_REVOCATION_TS,
  ISSUANCE_SEQUENCE,
  ISSUED_AT,
  ISSUED_TX_HASH,
  ISSUED_TX_TS,
  REVOCATION_SEQUENCE,
  REVOKED_AT,
  REVOKED_TX_HASH,
  REVOKED_TX_TS,
  STRANGER,
  TOPIC,
  auditContext,
  b32,
  consistentWorld,
  issuanceMessage,
  issuedLog,
  makeCredentialEvent,
  makeRevocation,
  revocationMessage,
  revokedLog,
} from "./test-fixtures";

const codes = (report: CredentialAuditReport) => report.findings.map(f => f.code);

describe("auditCredential", () => {
  describe("consistent evidence", () => {
    it("correlates the HCS issuance with the on-chain record and builds the timeline", async () => {
      const { ctx } = auditContext(await consistentWorld());
      const report = await auditCredential(CREDENTIAL_ID, ctx);

      expect(report.findings).toEqual([]);
      expect(report.evidence).toBe("consistent");
      expect(report.onChain.status).toBe("issued");
      expect(report.issuance?.matched).toBe(true);
      expect(report.issuance?.hcs).toMatchObject({ topicId: TOPIC, sequence: ISSUANCE_SEQUENCE });
      expect(report.issuance?.onChain).toMatchObject({
        transactionHash: ISSUED_TX_HASH,
        hcsSequence: ISSUANCE_SEQUENCE,
      });
      expect(report.revocation).toBeNull();
      expect(report.timeline).toEqual([
        {
          step: "hcs.issuance",
          consensusTimestamp: HCS_ISSUANCE_TS,
          reference: `${TOPIC}#5`,
          hashscanUrl: `https://hashscan.io/testnet/transaction/${HCS_ISSUANCE_TS}`,
        },
        {
          step: "chain.issued",
          consensusTimestamp: ISSUED_TX_TS,
          reference: ISSUED_TX_HASH,
          hashscanUrl: `https://hashscan.io/testnet/transaction/${ISSUED_TX_TS}`,
        },
      ]);
      expect(report.provenance).toMatchObject({
        network: "testnet",
        mirrorNode: "https://testnet.mirrornode.hedera.com",
        rpc: "https://testnet.hashio.io",
        topicId: TOPIC,
        highestConsensusTimestampSeen: ISSUED_TX_TS,
      });
    });

    it("correlates issuance and revocation in consensus order", async () => {
      const { ctx } = auditContext(await consistentWorld(true));
      const report = await auditCredential(CREDENTIAL_ID, ctx);

      expect(report.findings).toEqual([]);
      expect(report.evidence).toBe("consistent");
      expect(report.onChain.status).toBe("revoked");
      expect(report.revocation).toMatchObject({
        matched: true,
        hcs: { sequence: REVOCATION_SEQUENCE, reasonCode: b32("reason:superseded") },
        onChain: { transactionHash: REVOKED_TX_HASH, byAdmin: false },
      });
      expect(report.timeline.map(t => t.step)).toEqual([
        "hcs.issuance",
        "chain.issued",
        "hcs.revocation",
        "chain.revoked",
      ]);
      expect(report.timeline.map(t => t.consensusTimestamp)).toEqual([
        HCS_ISSUANCE_TS,
        ISSUED_TX_TS,
        HCS_REVOCATION_TS,
        REVOKED_TX_TS,
      ]);
    });

    it("accepts an admin revocation whose evidence is signed by the admin", async () => {
      const world = await consistentWorld(true);
      world.messages[1] = await revocationMessage(makeRevocation(), { signer: ADMIN });
      world.logs[1] = revokedLog({ revokedBy: ADMIN.address, byAdmin: true });
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
      expect(report.evidence).toBe("consistent");
      expect(report.revocation?.onChain?.byAdmin).toBe(true);
    });

    it("uses a known revocation sequence directly instead of scanning the topic", async () => {
      const { ctx, calls } = auditContext(await consistentWorld(true));
      const report = await auditCredential(CREDENTIAL_ID, ctx, { revocationHcsSequence: REVOCATION_SEQUENCE });
      expect(report.evidence).toBe("consistent");
      expect(calls.some(c => c.includes(`/messages/${REVOCATION_SEQUENCE}`))).toBe(true);
      expect(calls.some(c => /\/messages\?/.test(c))).toBe(false);
    });

    it("ignores topic noise and non-credential messages while scanning for revocation evidence", async () => {
      const world = await consistentWorld(true);
      world.messages.push(
        { sequence: 6n, consensusTimestamp: `${REVOKED_AT - 100n}.0`, bytes: Uint8Array.from([0x01, 2, 3]) },
        { sequence: 7n, consensusTimestamp: `${REVOKED_AT - 50n}.0`, bytes: new TextEncoder().encode("spam") },
      );
      expect((await auditCredential(CREDENTIAL_ID, auditContext(world).ctx)).evidence).toBe("consistent");
    });
  });

  describe("authority and availability", () => {
    it("reports a never-issued credential without querying the Mirror Node", async () => {
      const { ctx, calls } = auditContext(await consistentWorld());
      const report = await auditCredential(id("never-issued"), ctx);
      expect(report.onChain.status).toBe("not_found");
      expect(report.evidence).toBe("not_applicable");
      expect(report.timeline).toEqual([]);
      expect(calls.every(c => c.startsWith("POST"))).toBe(true);
    });

    it("reports an unreachable registry as unknown/unavailable instead of throwing", async () => {
      const world = await consistentWorld();
      const { ctx } = auditContext({ ...world, offline: true });
      const report = await auditCredential(CREDENTIAL_ID, ctx);
      expect(report.onChain.status).toBe("unknown");
      expect(report.evidence).toBe("unavailable");
      expect(codes(report)).toEqual(["REGISTRY_UNAVAILABLE"]);
    });

    it("keeps the on-chain status when the Mirror Node stays unavailable", async () => {
      const world = await consistentWorld();
      world.failures = { "/results/logs": 503 };
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
      expect(report.onChain.status).toBe("issued");
      expect(report.evidence).toBe("unavailable");
      expect(codes(report)).toEqual(["MIRROR_UNAVAILABLE"]);
    });
  });

  describe("eventual consistency", () => {
    it("polls with backoff until the log and the HCS message are indexed", async () => {
      const world = await consistentWorld();
      world.logs[0].visibleAfterReads = 3;
      world.messages[0].visibleAfterReads = 2;
      const { ctx, clock } = auditContext(world);
      const report = await auditCredential(CREDENTIAL_ID, ctx);
      expect(report.evidence).toBe("consistent");
      // Log hidden for 3 reads, then the message for 2: each poll restarts its own backoff.
      expect(clock.sleeps).toEqual([500, 1_000, 2_000, 500, 1_000]);
    });

    it("reports a not-yet-indexed log as pending inside the index budget", async () => {
      const world = await consistentWorld();
      world.logs[0].visibleAfterReads = 1_000;
      const { ctx } = auditContext(world, { nowSeconds: ISSUED_AT + 20n });
      const report = await auditCredential(CREDENTIAL_ID, ctx);
      expect(codes(report)).toEqual(["ONCHAIN_LOG_PENDING"]);
      expect(report.evidence).toBe("pending_index");
      expect(report.onChain.status).toBe("issued");
    });

    it("reports the log as missing only after the index budget", async () => {
      const world = await consistentWorld();
      world.logs = [];
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: ISSUED_AT + 300n }).ctx);
      expect(codes(report)).toEqual(["ONCHAIN_LOG_MISSING"]);
      expect(report.evidence).toBe("inconsistent");
    });

    it("distinguishes a pending from a missing HCS message", async () => {
      const world = await consistentWorld();
      world.messages = [];
      const young = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: ISSUED_AT + 10n }).ctx);
      expect(codes(young)).toEqual(["HCS_PENDING_INDEX"]);
      const old = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: ISSUED_AT + 300n }).ctx);
      expect(codes(old)).toEqual(["HCS_MISSING"]);
    });

    it("distinguishes pending from missing revocation evidence", async () => {
      const world = await consistentWorld(true);
      world.messages = world.messages.slice(0, 1);
      const young = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: REVOKED_AT + 10n }).ctx);
      expect(codes(young)).toEqual(["REVOCATION_EVIDENCE_PENDING"]);
      expect(young.evidence).toBe("pending_index");
      const old = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: REVOKED_AT + 600n }).ctx);
      expect(codes(old)).toEqual(["REVOCATION_EVIDENCE_MISSING"]);
      expect(old.evidence).toBe("inconsistent");
    });
  });

  describe("inconsistencies", () => {
    it("flags an undecodable message at the claimed sequence", async () => {
      const world = await consistentWorld();
      world.messages[0].bytes = new TextEncoder().encode("not a credential");
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual(["HCS_UNDECODABLE"]);
    });

    it("flags a digest that differs from the one emitted on-chain", async () => {
      const world = await consistentWorld();
      world.logs[0] = issuedLog(makeCredentialEvent(), { digest: b32("other-digest") });
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual(["HCS_DIGEST_MISMATCH"]);
    });

    it("flags HCS evidence signed by someone other than the recorded signer", async () => {
      const world = await consistentWorld();
      world.messages[0] = await issuanceMessage(makeCredentialEvent(), { signer: STRANGER });
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
      expect(codes(report)).toEqual(["HCS_SIGNER_MISMATCH"]);
      expect(report.issuance?.matched).toBe(false);
    });

    it("flags HCS content that differs from the on-chain record", async () => {
      const world = await consistentWorld();
      world.messages[0] = await issuanceMessage(makeCredentialEvent({ credentialHash: b32("tampered-document") }));
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual([
        "HCS_DIGEST_MISMATCH",
        "HCS_CONTENT_MISMATCH",
      ]);
    });

    it("flags evidence committed after the issuance transaction (commit-before-execute)", async () => {
      const world = await consistentWorld();
      const late = `${ISSUED_AT + 5n}.000000000`;
      world.messages[0] = await issuanceMessage(makeCredentialEvent(), { ts: late });
      world.logs[0] = issuedLog(makeCredentialEvent(), { hcsTs: late });
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual(["HCS_AFTER_ONCHAIN"]);
    });

    it("flags a consensus timestamp claim that does not match the message", async () => {
      const world = await consistentWorld();
      world.logs[0] = issuedLog(makeCredentialEvent(), { hcsTs: `${ISSUED_AT - 100n}.000000000` });
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual(["HCS_REF_MISMATCH"]);
    });

    it("flags an on-chain reference that points to another message", async () => {
      const world = await consistentWorld(true);
      world.logs[0] = issuedLog(makeCredentialEvent(), { hcsSequence: REVOCATION_SEQUENCE, hcsTs: HCS_REVOCATION_TS });
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
      expect(codes(report)).toContain("HCS_REF_MISMATCH");
    });

    it("never takes another credential's revocation as evidence", async () => {
      const world = await consistentWorld(true);
      world.messages[1] = await revocationMessage(makeRevocation({ credentialId: b32("another-credential") }));
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world, { nowSeconds: REVOKED_AT + 600n }).ctx);
      expect(codes(report)).toEqual(["REVOCATION_EVIDENCE_MISSING"]);
      expect(report.revocation?.hcs).toBeNull();
    });

    it("flags a revocation whose evidence is signed by someone other than revokedBy", async () => {
      const world = await consistentWorld(true);
      world.logs[1] = revokedLog({ revokedBy: ADMIN.address, byAdmin: true });
      const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
      expect(codes(report)).toEqual(["REVOCATION_SIGNER_MISMATCH"]);
      expect(report.revocation?.matched).toBe(false);
    });

    it("flags revocation evidence committed after the revocation transaction", async () => {
      const world = await consistentWorld(true);
      world.messages[1] = await revocationMessage(makeRevocation(), { ts: `${REVOKED_AT + 10n}.0` });
      expect(codes(await auditCredential(CREDENTIAL_ID, auditContext(world).ctx))).toEqual([
        "REVOCATION_AFTER_ONCHAIN",
      ]);
    });
  });
});

describe("auditHcsMessage", () => {
  it("audits from the issuance message the on-chain record references", async () => {
    const { ctx } = auditContext(await consistentWorld());
    const report = await auditHcsMessage(ISSUANCE_SEQUENCE, ctx);
    expect(report.subject).toEqual({ kind: "hcs", topicId: TOPIC, sequence: ISSUANCE_SEQUENCE });
    expect(report.credentialId).toBe(CREDENTIAL_ID);
    expect(report.evidence).toBe("consistent");
  });

  it("recognizes a benign duplicate (re-signed, same content)", async () => {
    const world = await consistentWorld();
    world.messages.push(
      await issuanceMessage(makeCredentialEvent({ signedAt: ISSUED_AT - 2n }), {
        sequence: 6n,
        ts: `${ISSUED_AT - 1n}.0`,
      }),
    );
    const report = await auditHcsMessage(6n, auditContext(world).ctx);
    expect(codes(report)).toEqual(["HCS_DUPLICATE_BENIGN"]);
    expect(report.evidence).toBe("consistent");
  });

  it("flags an equivocation: validly signed issuance with different content", async () => {
    const world = await consistentWorld();
    world.messages.push(
      await issuanceMessage(makeCredentialEvent({ credentialHash: b32("other-document") }), { sequence: 6n }),
    );
    const report = await auditHcsMessage(6n, auditContext(world).ctx);
    expect(codes(report)).toEqual(["HCS_EQUIVOCATION"]);
    expect(report.evidence).toBe("inconsistent");
  });

  it("reports valid evidence that is not registered on-chain", async () => {
    const world = await consistentWorld();
    world.records.clear();
    const report = await auditHcsMessage(ISSUANCE_SEQUENCE, auditContext(world).ctx);
    expect(report.onChain.status).toBe("not_found");
    expect(codes(report)).toEqual(["HCS_NOT_ONCHAIN"]);
  });

  it("reports a published revocation that was not executed on-chain", async () => {
    const world = await consistentWorld();
    world.messages.push(await revocationMessage());
    const report = await auditHcsMessage(REVOCATION_SEQUENCE, auditContext(world).ctx);
    expect(report.onChain.status).toBe("issued");
    expect(codes(report)).toEqual(["REVOCATION_NOT_EXECUTED"]);
  });

  it("audits from a revocation message using it as the revocation evidence", async () => {
    const report = await auditHcsMessage(REVOCATION_SEQUENCE, auditContext(await consistentWorld(true)).ctx);
    expect(report.evidence).toBe("consistent");
    expect(report.revocation?.hcs?.sequence).toBe(REVOCATION_SEQUENCE);
  });

  it("reports undecodable and absent messages without throwing", async () => {
    const world = await consistentWorld();
    world.messages[0].bytes = new TextEncoder().encode("noise");
    const undecodable = await auditHcsMessage(ISSUANCE_SEQUENCE, auditContext(world).ctx);
    expect(undecodable.credentialId).toBeNull();
    expect(codes(undecodable)).toEqual(["HCS_UNDECODABLE"]);

    const absent = await auditHcsMessage(404n, auditContext(world).ctx);
    expect(codes(absent)).toEqual(["HCS_NOT_FOUND"]);
  });
});
