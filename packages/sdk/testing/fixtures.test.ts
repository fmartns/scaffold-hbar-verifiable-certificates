import { describe, expect, it } from "vitest";
import { auditCredential } from "../hedera/audit/audit";
import { decodeCredentialMessage, encodeCredentialMessage } from "../hedera/hcs/credential-envelope";
import { INTEGRATION_IDS } from "../hedera/health";
import {
  CREDENTIAL_ID,
  DOMAIN,
  HEALTH_SCENARIOS,
  HEALTH_SECRET_KEY,
  ISSUER_SIGNER,
  TOPIC,
  auditContext,
  consistentWorld,
  createInMemoryTopic,
  fakeFetch,
  issuedLog,
  makeCredentialEvent,
  makeRevocation,
  recordOf,
  revokedLog,
  signIssuance,
  signRevocation,
} from "./index";
import type { FakeWorld } from "./index";

/** Seconds.nanos clock advancing one second per message, starting 3 s before the fixture issuance block. */
function consensusClock(startSeconds: bigint) {
  let s = startSeconds;
  return () => `${s++}.100000000`;
}

describe("shared credential fixtures", () => {
  it("are deterministic: the same inputs give byte-identical messages and signatures", async () => {
    const first = await signIssuance(makeCredentialEvent());
    const second = await signIssuance(makeCredentialEvent());
    expect(first).toBe(second);
    expect((await consistentWorld(true)).messages.map(m => Buffer.from(m.bytes).toString("hex"))).toEqual(
      (await consistentWorld(true)).messages.map(m => Buffer.from(m.bytes).toString("hex")),
    );
  });

  it("produce messages the single credential parser accepts", async () => {
    const [issuance, revocation] = (await consistentWorld(true)).messages;
    const decodedIssuance = decodeCredentialMessage(issuance.bytes, DOMAIN);
    const decodedRevocation = decodeCredentialMessage(revocation.bytes, DOMAIN);
    expect(decodedIssuance.ok && decodedIssuance.value.kind).toBe("issuance");
    expect(decodedRevocation.ok && decodedRevocation.value.kind).toBe("revocation");
  });

  it("reproduce a consistent issuance and revocation for the audit", async () => {
    const issued = await auditCredential(CREDENTIAL_ID, auditContext(await consistentWorld()).ctx);
    expect(issued.evidence).toBe("consistent");
    expect(issued.onChain.status).toBe("issued");

    const revoked = await auditCredential(CREDENTIAL_ID, auditContext(await consistentWorld(true)).ctx);
    expect(revoked.evidence).toBe("consistent");
    expect(revoked.onChain.status).toBe("revoked");
    expect(revoked.timeline.map(t => t.step)).toEqual([
      "hcs.issuance",
      "chain.issued",
      "hcs.revocation",
      "chain.revoked",
    ]);
  });

  it("serve an offline Mirror Node as a network failure", async () => {
    const { fetch } = fakeFetch({ messages: [], logs: [], records: new Map(), offline: true });
    await expect(fetch(`https://mirror.test/api/v1/topics/${TOPIC}/messages/1`)).rejects.toThrow("fetch failed");
  });
});

describe("in-memory HCS topic", () => {
  it("sequences messages, reports the transaction id first and makes them readable through the Mirror Node", async () => {
    const world: FakeWorld = { messages: [], logs: [], records: new Map() };
    const topic = createInMemoryTopic(world, { consensusAt: consensusClock(1_767_225_597n) });
    const seen: string[] = [];
    const message = encodeCredentialMessage({
      kind: "issuance",
      event: makeCredentialEvent(),
      signature: await signIssuance(makeCredentialEvent()),
    });

    const first = await topic.transport.submit({
      topicId: TOPIC,
      message,
      timeoutMs: 1_000,
      onTransactionId: id => seen.push(id),
    });
    const second = await topic.transport.submit({
      topicId: TOPIC,
      message,
      timeoutMs: 1_000,
      onTransactionId: id => seen.push(id),
    });

    expect([first.sequenceNumber, second.sequenceNumber]).toEqual(["1", "2"]);
    expect(seen).toEqual([first.transactionId, second.transactionId]);
    expect(first.consensusTimestamp).toBe("1767225597.100000000");

    const { fetch } = fakeFetch(world);
    const body = await (await fetch(`https://mirror.test/api/v1/topics/${TOPIC}/messages/1`)).json();
    expect(Buffer.from(body.message, "base64")).toEqual(Buffer.from(message));
  });

  it("appends nothing when a submission fails", async () => {
    const world: FakeWorld = { messages: [], logs: [], records: new Map() };
    const topic = createInMemoryTopic(world, { consensusAt: consensusClock(1n) });
    topic.failNext(new Error("INSUFFICIENT_PAYER_BALANCE"));
    await expect(
      topic.transport.submit({ topicId: TOPIC, message: new Uint8Array([1]), timeoutMs: 1, onTransactionId: () => {} }),
    ).rejects.toThrow("INSUFFICIENT_PAYER_BALANCE");
    expect(world.messages).toEqual([]);
  });

  it("drives issuance and revocation evidence the audit correlates", async () => {
    const event = makeCredentialEvent();
    const world: FakeWorld = { messages: [], logs: [], records: new Map() };
    const topic = createInMemoryTopic(world, { consensusAt: consensusClock(1_767_225_597n) });
    const submit = (message: Uint8Array) =>
      topic.transport.submit({ topicId: TOPIC, message, timeoutMs: 1_000, onTransactionId: () => {} });

    const issuance = await submit(
      encodeCredentialMessage({ kind: "issuance", event, signature: await signIssuance(event, ISSUER_SIGNER) }),
    );
    world.logs.push(
      issuedLog(event, { hcsSequence: BigInt(issuance.sequenceNumber), hcsTs: issuance.consensusTimestamp }),
    );
    world.records.set(CREDENTIAL_ID, recordOf(event, 2));

    // The revocation is committed later than the issuance, still before its transaction.
    const revocationTopic = createInMemoryTopic(world, { consensusAt: () => "1767226197.100000000" });
    await revocationTopic.transport.submit({
      topicId: TOPIC,
      message: encodeCredentialMessage({
        kind: "revocation",
        revocation: makeRevocation(),
        signature: await signRevocation(makeRevocation()),
      }),
      timeoutMs: 1_000,
      onTransactionId: () => {},
    });
    world.logs.push(revokedLog());

    const report = await auditCredential(CREDENTIAL_ID, auditContext(world).ctx);
    expect(report.findings).toEqual([]);
    expect(report.evidence).toBe("consistent");
    expect(report.issuance?.hcs?.sequence).toBe(1n);
    expect(report.revocation?.hcs?.sequence).toBe(2n);
  });
});

describe("health scenarios", () => {
  it("cover each state the dashboard renders, without leaking the operator key", async () => {
    const overall: Record<string, string> = {};
    for (const [name, scenario] of Object.entries(HEALTH_SCENARIOS)) {
      const { report } = await scenario();
      overall[name] = report.overall;
      expect(Object.keys(report.integrations)).toEqual([...INTEGRATION_IDS]);
      expect(JSON.stringify(report)).not.toContain(HEALTH_SECRET_KEY);
    }
    expect(overall).toEqual({
      healthy: "ok",
      unconfigured: "not_configured",
      invalidNetwork: "error",
      mirrorDown: "error",
      lowBalance: "error",
      registryMissing: "error",
    });
  });
});
