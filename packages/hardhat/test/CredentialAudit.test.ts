import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroAddress, id, keccak256, toUtf8Bytes } from "ethers";
import {
  CREDENTIAL_EIP712_NAME,
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_EVENT_TYPE_STRING,
  CREDENTIAL_ISSUED_TOPIC,
  CREDENTIAL_KEY_TAG,
  CREDENTIAL_REVOCATION_TYPES,
  CREDENTIAL_REVOKED_TOPIC,
  auditCredential,
  computeCredentialDigest,
  computeCredentialId,
  credentialDomain,
  encodeCredentialMessage,
  readRegistryDeployment,
} from "@sh/sdk";
import type { CredentialEvent, HederaNetwork } from "@sh/sdk";
import { auditContext } from "@sh/sdk/testing";
import type { FakeWorld } from "@sh/sdk/testing";

/**
 * Cross-checks the SDK audit (#10) against the compiled CredentialRegistry (#9): the SDK's event topics (from the
 * generated ABI, #24), type strings and credentialId formula must match the contract, and an audit over REAL receipt logs must correlate.
 * The shared fake Mirror Node is fed with those receipts; `statusOf` goes to the Hardhat node over eth_call.
 */
const TOPIC = "0.0.4567";
const HCS = { issuance: 5n, revocation: 9n };
const ISSUER = id("acme-university");

describe("CredentialRegistry ↔ SDK audit", function () {
  async function deployFixture() {
    const [admin, issuerSigner] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, 4567n);
    await registry.registerIssuer(ISSUER, issuerSigner.address, 900n);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { chainId, verifyingContract: (await registry.getAddress()).toLowerCase() };
    return { registry, admin, issuerSigner, domain };
  }

  it("pins the SDK identifiers and event signatures to the contract", async function () {
    const { registry, domain } = await loadFixture(deployFixture);
    const now = BigInt(await time.latest());
    const event: CredentialEvent = {
      version: 1,
      issuer: ISSUER as `0x${string}`,
      externalCredentialId: id("diploma:1") as `0x${string}`,
      credentialHash: id("doc") as `0x${string}`,
      subjectCommitment: id("subject") as `0x${string}`,
      schemaId: id("schema") as `0x${string}`,
      signedAt: now,
      validUntil: now + 600n,
      submitter: ZeroAddress as `0x${string}`,
    };

    expect(await registry.CREDENTIAL_EVENT_TYPEHASH()).to.equal(keccak256(toUtf8Bytes(CREDENTIAL_EVENT_TYPE_STRING)));
    expect(await registry.CREDENTIAL_KEY_TAG()).to.equal(CREDENTIAL_KEY_TAG);
    expect(await registry.EIP712_NAME()).to.equal(CREDENTIAL_EIP712_NAME);
    expect(await registry.computeCredentialId(event.issuer, event.externalCredentialId)).to.equal(
      computeCredentialId(event.issuer, event.externalCredentialId),
    );
    expect(await registry.hashCredentialEvent(event)).to.equal(computeCredentialDigest(event, domain));
    expect(registry.interface.getEvent("CredentialIssued").topicHash).to.equal(CREDENTIAL_ISSUED_TOPIC);
    expect(registry.interface.getEvent("CredentialRevoked").topicHash).to.equal(CREDENTIAL_REVOKED_TOPIC);
  });

  it("audits a real issuance and revocation as consistent", async function () {
    const { registry, issuerSigner, domain } = await loadFixture(deployFixture);
    const registryAddress = domain.verifyingContract;

    const signedAt = BigInt(await time.latest());
    const event: CredentialEvent = {
      version: 1,
      issuer: ISSUER as `0x${string}`,
      externalCredentialId: id("diploma:2026:0001") as `0x${string}`,
      credentialHash: id("credential-document-v1") as `0x${string}`,
      subjectCommitment: id("salted-subject") as `0x${string}`,
      schemaId: id("schema:diploma:v1") as `0x${string}`,
      signedAt,
      validUntil: signedAt + 600n,
      submitter: ZeroAddress as `0x${string}`,
    };
    const credentialId = computeCredentialId(event.issuer, event.externalCredentialId);
    const issuanceSig = await issuerSigner.signTypedData(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event);

    // HCS consensus 3 s before the transaction's block (commit-before-execute).
    const issueBlockTs = signedAt + 10n;
    const hcsIssuanceTs = `${issueBlockTs - 3n}.100000000`;
    await time.setNextBlockTimestamp(issueBlockTs);
    const issueReceipt = await (
      await registry.issue(event, issuanceSig, {
        sequence: HCS.issuance,
        consensusTimestampNs: (issueBlockTs - 3n) * 1_000_000_000n + 100_000_000n,
      })
    ).wait();

    const revocation = {
      version: 1,
      credentialId,
      issuer: event.issuer,
      reasonCode: id("reason:superseded") as `0x${string}`,
      signedAt: issueBlockTs + 100n,
    };
    const revocationSig = await issuerSigner.signTypedData(
      credentialDomain(domain),
      CREDENTIAL_REVOCATION_TYPES,
      revocation,
    );
    const revokeBlockTs = issueBlockTs + 110n;
    const hcsRevocationTs = `${revokeBlockTs - 3n}.100000000`;
    await time.setNextBlockTimestamp(revokeBlockTs);
    const revokeReceipt = await (await registry.connect(issuerSigner).revoke(credentialId)).wait();

    const world: FakeWorld = {
      topicId: TOPIC,
      records: new Map(),
      rpc: (params, method) => ethers.provider.send(method, params),
      logs: [
        ...issueReceipt!.logs.map(l => ({ ...l, ts: `${issueBlockTs}.000000001` })),
        ...revokeReceipt!.logs.map(l => ({ ...l, ts: `${revokeBlockTs}.000000001` })),
      ].map(l => ({
        address: l.address,
        topics: l.topics.map(t => t.toLowerCase()),
        data: l.data,
        consensusTimestamp: l.ts,
        transactionHash: l.transactionHash.toLowerCase(),
      })),
      messages: [
        {
          sequence: HCS.issuance,
          consensusTimestamp: hcsIssuanceTs,
          bytes: encodeCredentialMessage({ kind: "issuance", event, signature: issuanceSig }),
        },
        {
          sequence: HCS.revocation,
          consensusTimestamp: hcsRevocationTs,
          bytes: encodeCredentialMessage({ kind: "revocation", revocation, signature: revocationSig }),
        },
      ],
    };
    const network: HederaNetwork = {
      name: "local",
      chainId: Number(domain.chainId),
      rpcUrl: "http://127.0.0.1:8545",
      mirrorNodeUrl: "http://127.0.0.1:5551",
      hashscanUrl: null,
    };
    const { ctx } = auditContext(world, {
      network,
      registryAddress,
      pollTimeoutMs: 0,
      nowSeconds: revokeBlockTs + 30n,
    });

    const report = await auditCredential(credentialId, ctx);
    expect(report.findings, JSON.stringify(report.findings)).to.deep.equal([]);
    expect(report.evidence).to.equal("consistent");
    expect(report.onChain.status).to.equal("revoked");
    expect(report.onChain.record?.issuedAt).to.equal(issueBlockTs);
    expect(report.issuance?.matched).to.equal(true);
    expect(report.revocation?.matched).to.equal(true);
    expect(report.timeline.map(t => t.step)).to.deep.equal([
      "hcs.issuance",
      "chain.issued",
      "hcs.revocation",
      "chain.revoked",
    ]);
    expect(report.issuance?.onChain?.transactionHash).to.equal(issueReceipt!.hash.toLowerCase());
  });

  it("reads the deployment state the environment dashboard shows", async function () {
    const { registry, admin } = await loadFixture(deployFixture);
    const relay = (async (_input: string | URL | Request, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body));
      const result = await ethers.provider.send("eth_call", params);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as typeof fetch;
    const network: HederaNetwork = {
      name: "local",
      chainId: 31337,
      rpcUrl: "http://127.0.0.1:8545",
      mirrorNodeUrl: "http://127.0.0.1:5551",
      hashscanUrl: null,
    };
    const read = () => readRegistryDeployment({ network, registryAddress: registry.target as string, fetch: relay });

    expect(await read()).to.deep.equal({ hcsTopicNum: 4567n, paused: false });
    await registry.connect(admin).setPaused(true);
    expect((await read()).paused).to.equal(true);
  });
});
