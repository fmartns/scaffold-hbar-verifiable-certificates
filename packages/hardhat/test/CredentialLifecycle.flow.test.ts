import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { ContractTransactionResponse } from "ethers";
import {
  auditCredential,
  auditHcsMessage,
  buildCredentialMessage,
  computeCredentialId,
  decodeCredentialMessage,
  encodeCredentialMessage,
  timestampToNanoseconds,
} from "@sh/sdk";
import type { CredentialEvent, CredentialMessageInput, CredentialRevocation, HederaNetwork } from "@sh/sdk";
import {
  ISSUER,
  TOPIC,
  auditContext,
  b32,
  createInMemoryTopic,
  makeCredentialEvent,
  makeRevocation,
  signIssuance,
  signRevocation,
} from "@sh/sdk/testing";
import type { FakeWorld, TypedDataSigner } from "@sh/sdk/testing";

/**
 * End-to-end credential flow without a real network: issuer → HCS → CredentialRegistry → verifier.
 *
 * - Issuer: signs the event, validates it with the SDK builder and publishes it through the real `HcsTransport` port
 *   (an in-memory topic). The contract is called only after the consensus receipt (ADR D11).
 * - Contract: the compiled CredentialRegistry on the Hardhat network.
 * - Verifier: the SDK audit (#10) over a fake Mirror Node fed with the topic messages and the REAL receipt logs; `statusOf`
 *   is relayed to the Hardhat node.
 */
type Domain = { chainId: bigint; verifyingContract: string };

const LOCAL: Omit<HederaNetwork, "chainId"> = {
  name: "local",
  rpcUrl: "http://127.0.0.1:8545",
  mirrorNodeUrl: "http://127.0.0.1:5551",
  hashscanUrl: null,
};

describe("Credential lifecycle: issuer → HCS → CredentialRegistry → verifier", function () {
  async function chainFixture() {
    const [admin, issuerSigner, relayer, stranger] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, 4567n);
    await registry.registerIssuer(ISSUER, issuerSigner.address, 900n);
    return { registry, admin, issuerSigner, relayer, stranger };
  }

  /** Chain state comes from the snapshot; the off-chain world (topic, Mirror Node) is fresh for every test. */
  async function deployFixture() {
    const { registry, admin, issuerSigner, relayer, stranger } = await loadFixture(chainFixture);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const registryAddress = (await registry.getAddress()).toLowerCase();
    const domain = { chainId, verifyingContract: registryAddress };
    const network: HederaNetwork = { ...LOCAL, chainId: Number(chainId) };

    const world: FakeWorld = {
      messages: [],
      logs: [],
      records: new Map(),
      topicId: TOPIC,
      rpc: (params, method) => ethers.provider.send(method, params),
    };
    // HCS consensus is whatever the test sets just before publishing.
    let nextConsensus = "0.000000000";
    const topic = createInMemoryTopic(world, { consensusAt: () => nextConsensus });

    /** The issuer's side: validate, publish, and return the HcsRef only from the consensus receipt. */
    async function publish(input: CredentialMessageInput, consensusSeconds: bigint) {
      const built = buildCredentialMessage(input, domain);
      if (!built.ok) throw new Error(`invalid credential message: ${JSON.stringify(built.issues)}`);
      nextConsensus = `${consensusSeconds}.100000000`;
      const receipt = await topic.transport.submit({
        topicId: TOPIC,
        message: encodeCredentialMessage(built.value),
        timeoutMs: 1_000,
        onTransactionId: () => {},
      });
      return {
        receipt,
        hcsRef: {
          sequence: BigInt(receipt.sequenceNumber),
          consensusTimestampNs: BigInt(timestampToNanoseconds(receipt.consensusTimestamp)),
        },
      };
    }

    /** The Mirror Node indexes a mined transaction's logs at its block time. */
    async function index(tx: ContractTransactionResponse) {
      const receipt = (await tx.wait())!;
      const block = (await ethers.provider.getBlock(receipt.blockNumber))!;
      for (const log of receipt.logs) {
        world.logs.push({
          address: log.address,
          topics: log.topics.map(t => t.toLowerCase()),
          data: log.data,
          consensusTimestamp: `${block.timestamp}.000000001`,
          transactionHash: receipt.hash.toLowerCase(),
        });
      }
      return BigInt(block.timestamp);
    }

    const verifier = (nowSeconds: bigint, pollTimeoutMs = 0) =>
      auditContext(world, { network, registryAddress, nowSeconds, pollTimeoutMs }).ctx;

    return { registry, admin, issuerSigner, relayer, stranger, domain, world, topic, publish, index, verifier };
  }

  async function signedEvent(signer: TypedDataSigner, domain: Domain) {
    const signedAt = BigInt(await time.latest());
    const event: CredentialEvent = makeCredentialEvent({ signedAt, validUntil: signedAt + 600n });
    return { event, signature: await signIssuance(event, signer, domain), signedAt };
  }

  async function issueFlow() {
    const ctx = await deployFixture();
    const { registry, issuerSigner, relayer, domain, publish, index } = ctx;
    const { event, signature, signedAt } = await signedEvent(issuerSigner, domain);
    const { hcsRef, receipt } = await publish({ kind: "issuance", event, signature }, signedAt + 2n);
    await time.setNextBlockTimestamp(signedAt + 5n);
    const issuedAt = await index(await registry.connect(relayer).issue(event, signature, hcsRef));
    const credentialId = computeCredentialId(event.issuer, event.externalCredentialId);
    return { ...ctx, event, signature, hcsRef, receipt, issuedAt, credentialId };
  }

  async function revocationFor(credentialId: string, signer: TypedDataSigner, signedAt: bigint, domain: Domain) {
    const revocation: CredentialRevocation = makeRevocation({ credentialId: credentialId as `0x${string}`, signedAt });
    return { revocation, signature: await signRevocation(revocation, signer, domain) };
  }

  it("issues and revokes a credential with consistent HCS evidence the verifier correlates", async function () {
    const { registry, issuerSigner, domain, world, publish, index, verifier, event, hcsRef, issuedAt, credentialId } =
      await issueFlow();

    const issued = await auditCredential(credentialId, verifier(issuedAt + 30n));
    expect(issued.findings, JSON.stringify(issued.findings)).to.deep.equal([]);
    expect(issued.evidence).to.equal("consistent");
    expect(issued.onChain.status).to.equal("issued");
    expect(issued.issuance?.hcs?.sequence).to.equal(hcsRef.sequence);

    // The evidence the Mirror Node returns decodes, with the single parser, to the digest the contract computed.
    const decoded = decodeCredentialMessage(world.messages[0].bytes, domain);
    expect(decoded.ok && decoded.value.derived.digest).to.equal(await registry.hashCredentialEvent(event));

    const { revocation, signature } = await revocationFor(credentialId, issuerSigner, issuedAt + 100n, domain);
    await publish({ kind: "revocation", revocation, signature }, issuedAt + 101n);
    await time.setNextBlockTimestamp(issuedAt + 105n);
    const revokedAt = await index(await registry.connect(issuerSigner).revoke(credentialId));

    const revoked = await auditCredential(credentialId, verifier(revokedAt + 30n));
    expect(revoked.findings, JSON.stringify(revoked.findings)).to.deep.equal([]);
    expect(revoked.evidence).to.equal("consistent");
    expect(revoked.onChain.status).to.equal("revoked");
    expect(revoked.revocation?.onChain?.byAdmin).to.equal(false);
    expect(revoked.timeline.map(t => t.step)).to.deep.equal([
      "hcs.issuance",
      "chain.issued",
      "hcs.revocation",
      "chain.revoked",
    ]);
    // Local network: no public explorer, so no invented HashScan links.
    expect(revoked.timeline.every(t => t.hashscanUrl === null)).to.equal(true);
  });

  it("does not reach the contract when the HCS publication fails (commit before execute)", async function () {
    const { issuerSigner, domain, world, topic, publish, verifier } = await deployFixture();
    const { event, signature, signedAt } = await signedEvent(issuerSigner, domain);
    topic.failNext(new Error("INSUFFICIENT_PAYER_BALANCE"));

    const failure = await publish({ kind: "issuance", event, signature }, signedAt + 1n).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).to.equal("INSUFFICIENT_PAYER_BALANCE");

    expect(world.messages).to.deep.equal([]);
    const report = await auditCredential(
      computeCredentialId(event.issuer, event.externalCredentialId),
      verifier(signedAt),
    );
    expect(report.onChain.status).to.equal("not_found");
    expect(report.evidence).to.equal("not_applicable");
  });

  it("treats HCS as evidence, not validity: a published message signed by a stranger is never registered", async function () {
    const { registry, stranger, domain, publish, verifier } = await deployFixture();
    const { event, signature, signedAt } = await signedEvent(stranger, domain);
    const { hcsRef } = await publish({ kind: "issuance", event, signature }, signedAt + 1n);

    await expect(registry.issue(event, signature, hcsRef)).to.be.revertedWithCustomError(
      registry,
      "UnauthorizedSigner",
    );

    const report = await auditHcsMessage(hcsRef.sequence, verifier(signedAt + 30n));
    expect(report.onChain.status).to.equal("not_found");
    expect(report.findings.map(f => f.code)).to.include("HCS_NOT_ONCHAIN");
  });

  it("reports missing Mirror data as pending inside the index budget, then consistent once indexed", async function () {
    const { world, verifier, issuedAt, credentialId } = await issueFlow();
    for (const item of [...world.messages, ...world.logs]) item.visibleAfterReads = 1_000;

    const pending = await auditCredential(credentialId, verifier(issuedAt + 5n));
    expect(pending.onChain.status, "statusOf stays authoritative").to.equal("issued");
    expect(pending.evidence).to.equal("pending_index");

    for (const item of [...world.messages, ...world.logs]) item.visibleAfterReads = 0;
    const indexed = await auditCredential(credentialId, verifier(issuedAt + 5n));
    expect(indexed.evidence).to.equal("consistent");
  });

  it("flags on-chain records whose HcsRef points at different content", async function () {
    const { registry, issuerSigner, relayer, domain, publish, index, verifier } = await deployFixture();
    const { event, signature, signedAt } = await signedEvent(issuerSigner, domain);
    const decoy = makeCredentialEvent({ ...event, credentialHash: b32("another-document") });
    const { hcsRef } = await publish(
      { kind: "issuance", event: decoy, signature: await signIssuance(decoy, issuerSigner, domain) },
      signedAt + 1n,
    );
    await time.setNextBlockTimestamp(signedAt + 5n);
    const issuedAt = await index(await registry.connect(relayer).issue(event, signature, hcsRef));

    const report = await auditCredential(
      computeCredentialId(event.issuer, event.externalCredentialId),
      verifier(issuedAt + 30n),
    );
    expect(report.onChain.status).to.equal("issued");
    expect(report.evidence).to.equal("inconsistent");
    expect(report.findings.map(f => f.code)).to.include.members(["HCS_DIGEST_MISMATCH", "HCS_CONTENT_MISMATCH"]);
  });

  it("rejects replays and unauthorized revocations without changing what the verifier sees", async function () {
    const { registry, relayer, stranger, verifier, event, signature, hcsRef, issuedAt, credentialId } =
      await issueFlow();

    await expect(registry.connect(relayer).issue(event, signature, hcsRef)).to.be.revertedWithCustomError(
      registry,
      "AlreadyIssued",
    );
    await expect(registry.connect(stranger).revoke(credentialId)).to.be.revertedWithCustomError(
      registry,
      "UnauthorizedRevoker",
    );

    const report = await auditCredential(credentialId, verifier(issuedAt + 30n));
    expect(report.onChain.status).to.equal("issued");
    expect(report.evidence).to.equal("consistent");
  });

  it("correlates an admin revocation whose evidence the admin signed", async function () {
    const { registry, admin, domain, publish, index, verifier, issuedAt, credentialId } = await issueFlow();
    const { revocation, signature } = await revocationFor(credentialId, admin, issuedAt + 50n, domain);
    await publish({ kind: "revocation", revocation, signature }, issuedAt + 51n);
    await time.setNextBlockTimestamp(issuedAt + 55n);
    const revokedAt = await index(await registry.connect(admin).revoke(credentialId));

    const report = await auditCredential(credentialId, verifier(revokedAt + 30n));
    expect(report.findings, JSON.stringify(report.findings)).to.deep.equal([]);
    expect(report.onChain.status).to.equal("revoked");
    expect(report.revocation?.onChain?.byAdmin).to.equal(true);
  });
});
