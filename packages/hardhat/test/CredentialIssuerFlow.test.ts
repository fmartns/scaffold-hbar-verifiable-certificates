import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_SCHEMA_PRESETS,
  IssuerFlowError,
  buildCredentialDraft,
  buildCredentialMessage,
  computeIssuerId,
  credentialDomain,
  runIssuance,
  runRevocation,
} from "@sh/sdk";
import type {
  CredentialDraftInput,
  CredentialPublishReceipt,
  Eip1193Like,
  IssuerBackend,
  IssuerFlowContext,
} from "@sh/sdk";
import { ZeroAddress } from "ethers";

/**
 * Drives the issuer console flow (#12) against the compiled CredentialRegistry over a real EIP-1193 provider: the
 * calldata built from the generated ABI must be accepted, the wallet's EIP-712 payload must verify on-chain, and
 * reverts must surface as the specific console errors. HCS is simulated by the backend port.
 */
const ISSUER_NAME = "acme-university";
const INPUT: CredentialDraftInput = {
  issuerName: ISSUER_NAME,
  schema: CREDENTIAL_SCHEMA_PRESETS[1].descriptor,
  reference: "ENR-2026-0042",
  subjectIdType: "email",
  subjectIdValue: "maria.silva@example.com",
  issuedOn: "2026-09-21",
  expiresOn: "",
  claims: {
    courseCode: "CS-301",
    courseName: "Distributed Ledgers",
    completedOn: "2026-09-20",
    hours: "60",
    grade: "A",
  },
  validitySeconds: 600,
};
const FORGED_HCS_REF = { sequence: 999n, consensusTimestampNs: 1n };

describe("CredentialRegistry ↔ SDK issuer flow", function () {
  async function deployFixture() {
    const [admin, issuerSigner, stranger] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, 4567n);
    await registry.registerIssuer(computeIssuerId(ISSUER_NAME), issuerSigner.address, 900n);
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const registryAddress = (await registry.getAddress()).toLowerCase();
    return { registry, admin, issuerSigner, stranger, chainId, registryAddress };
  }

  /** The node's EIP-1193 provider, with `account` as the only connected account (like a browser wallet). */
  const walletFor = (account: string): Eip1193Like => ({
    request: ({ method, params }) =>
      method === "eth_accounts"
        ? Promise.resolve([account.toLowerCase()])
        : network.provider.request({ method, params: params as unknown[] }),
  });

  function backendFor(
    registry: Awaited<ReturnType<typeof deployFixture>>["registry"],
    chainId: number,
    onPublished?: (request: Parameters<IssuerBackend["publish"]>[0]) => Promise<void>,
  ) {
    let sequence = 0;
    const published: CredentialPublishReceipt[] = [];
    const backend: IssuerBackend = {
      async publish(request) {
        const domain = { chainId, verifyingContract: (await registry.getAddress()).toLowerCase() };
        const built = buildCredentialMessage(
          request.kind === "issuance"
            ? { kind: "issuance", event: request.event, signature: request.signature }
            : { kind: "revocation", revocation: request.revocation, signature: request.signature },
          domain,
        );
        if (!built.ok) throw new Error("invalid message");
        sequence += 1;
        const ts = `${await time.latest()}.000000001`;
        const receipt: CredentialPublishReceipt = {
          kind: request.kind,
          credentialId: built.value.derived.credentialId,
          digest: built.value.derived.digest,
          signer: built.value.derived.signer,
          topicId: "0.0.4567",
          network: "local",
          transactionId: `0.0.1001@${ts}`,
          mirrorTransactionId: `0.0.1001-${ts.replace(".", "-")}`,
          hcsRef: { sequence: String(sequence), consensusTimestampNs: ts.replace(".", "") },
          consensusTimestamp: ts,
          hashscanUrl: null,
          hashscanTopicUrl: null,
          mirrorMessageUrl: "",
          messageSha256: `0x${"00".repeat(32)}`,
          recordedAt: new Date().toISOString(),
        };
        published.push(receipt);
        // The message is now public on HCS: anyone reading the topic could act on it before the issuer does.
        await onPublished?.(request);
        return receipt;
      },
      async status(credentialId) {
        const r = await registry.statusOf(credentialId);
        const status = (["not_found", "issued", "revoked"] as const)[Number(r.status)];
        return {
          credentialId: credentialId as `0x${string}`,
          status,
          issuer: r.issuer.toLowerCase() as `0x${string}`,
          signer: r.signer.toLowerCase() as `0x${string}`,
          issuedAt: r.issuedAt.toString(),
          revokedAt: r.revokedAt.toString(),
        };
      },
    };
    return { backend, published };
  }

  async function context(
    account: string,
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    onPublished?: Parameters<typeof backendFor>[2],
  ): Promise<IssuerFlowContext & { published: CredentialPublishReceipt[] }> {
    const { backend, published } = backendFor(fixture.registry, fixture.chainId, onPublished);
    const nowMs = (await time.latest()) * 1000;
    return {
      provider: walletFor(account),
      backend,
      published,
      chainId: fixture.chainId,
      registryAddress: fixture.registryAddress,
      now: () => nowMs,
      receiptPollMs: 10,
    };
  }

  it("pins submitter so nobody can front-run issue() with a forged HcsRef (docs/security.md T-5/F-1)", async function () {
    const fixture = await loadFixture(deployFixture);
    const { registry, stranger } = fixture;
    let frontRunRejected = false;
    const ctx = await context(fixture.issuerSigner.address, fixture, async request => {
      if (request.kind !== "issuance") return;
      const event = {
        ...request.event,
        signedAt: BigInt(request.event.signedAt),
        validUntil: BigInt(request.event.validUntil),
      };
      await expect(
        registry.connect(stranger).issue(event as never, request.signature, FORGED_HCS_REF),
      ).to.be.revertedWithCustomError(registry, "SubmitterMismatch");
      frontRunRejected = true;
    });

    const issued = await runIssuance(INPUT, ctx);
    expect(frontRunRejected, "the front-run was attempted and rejected").to.equal(true);
    expect(issued.event.submitter).to.equal(fixture.issuerSigner.address.toLowerCase());
    const log = (await ethers.provider.getTransactionReceipt(issued.registration.transactionHash))!.logs
      .map(l => registry.interface.parseLog(l))
      .find(l => l?.name === "CredentialIssued");
    expect(log!.args.hcsSequence).to.equal(BigInt(ctx.published[0].hcsRef.sequence));
  });

  it("shows why: an unpinned (submitter = 0) event read from HCS can be front-run with a forged HcsRef", async function () {
    const fixture = await loadFixture(deployFixture);
    const { registry, issuerSigner, stranger, chainId, registryAddress } = fixture;
    const now = await time.latest();
    const draft = buildCredentialDraft(INPUT, { nowSeconds: now, submitter: issuerSigner.address });
    if (!draft.ok) throw new Error("draft failed");
    const unpinned = { ...draft.value.event, submitter: ZeroAddress as `0x${string}` };
    const signature = await issuerSigner.signTypedData(
      credentialDomain({ chainId, verifyingContract: registryAddress }),
      CREDENTIAL_EVENT_TYPES,
      unpinned,
    );
    const receipt = await (await registry.connect(stranger).issue(unpinned, signature, FORGED_HCS_REF)).wait();
    const log = receipt!.logs.map(l => registry.interface.parseLog(l)).find(l => l?.name === "CredentialIssued");
    expect(log!.args.hcsSequence).to.equal(FORGED_HCS_REF.sequence);
  });

  it("issues and revokes end to end: HCS receipt first, then the registry", async function () {
    const fixture = await loadFixture(deployFixture);
    const ctx = await context(fixture.issuerSigner.address, fixture);

    const issued = await runIssuance(INPUT, ctx);
    const record = await fixture.registry.statusOf(issued.credentialId);
    expect(record.status).to.equal(1n);
    expect(record.subjectCommitment).to.equal(issued.event.subjectCommitment);
    expect(ctx.published).to.have.length(1);

    const issuedLog = (await ethers.provider.getTransactionReceipt(issued.registration.transactionHash))!.logs
      .map(l => fixture.registry.interface.parseLog(l))
      .find(l => l?.name === "CredentialIssued");
    expect(issuedLog!.args.hcsSequence).to.equal(1n);

    const revoked = await runRevocation({ credentialId: issued.credentialId, reason: "superseded" }, ctx);
    expect((await fixture.registry.statusOf(issued.credentialId)).status).to.equal(2n);
    expect(revoked.hcs.kind).to.equal("revocation");
    expect(ctx.published).to.have.length(2);
  });

  it("surfaces real reverts as specific console errors, before anything is published", async function () {
    const fixture = await loadFixture(deployFixture);

    const strangerCtx = await context(fixture.stranger.address, fixture);
    try {
      await runIssuance(INPUT, strangerCtx);
      expect.fail("expected UnauthorizedSigner");
    } catch (error) {
      expect(error).to.be.instanceOf(IssuerFlowError);
      expect((error as IssuerFlowError).issuerError).to.include({
        category: "issuer_not_registered",
        code: "UnauthorizedSigner",
      });
    }

    const unknownCtx = await context(fixture.issuerSigner.address, fixture);
    try {
      await runIssuance({ ...INPUT, issuerName: "unregistered-org" }, unknownCtx);
      expect.fail("expected UnknownIssuer");
    } catch (error) {
      expect((error as IssuerFlowError).issuerError.code).to.equal("UnknownIssuer");
    }
    expect(strangerCtx.published).to.have.length(0);
    expect(unknownCtx.published).to.have.length(0);

    const ctx = await context(fixture.issuerSigner.address, fixture);
    await runIssuance(INPUT, ctx);
    try {
      // Same reference, fresh salt: same credentialId with different content.
      await runIssuance(INPUT, ctx);
      expect.fail("expected ConflictingCredential");
    } catch (error) {
      expect((error as IssuerFlowError).issuerError.code).to.equal("ConflictingCredential");
    }
    expect(ctx.published).to.have.length(1);
  });
});
