import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroAddress } from "ethers";
import { CREDENTIAL_EVENT_TYPES, credentialDomain, deriveCredential, toCredentialEvent } from "@sh/sdk";
import type { CredentialModel } from "@sh/sdk";
import { CREDENTIAL_EXAMPLES } from "@sh/sdk/hedera/credentials/test-fixtures";

/**
 * The credential model (docs/credential-schema.md, #38) is generic: three credential types from three issuers are
 * derived by the SDK and accepted unchanged by one CredentialRegistry, which records exactly the derived identifiers.
 */
describe("CredentialRegistry ↔ SDK credential schema", function () {
  async function deployFixture() {
    const [admin, ...signers] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("CredentialRegistry")).deploy(admin.address, 4567n);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { chainId, verifyingContract: (await registry.getAddress()).toLowerCase() };
    const models = Object.entries(CREDENTIAL_EXAMPLES).map(([name, document], i) => {
      const result = deriveCredential(document);
      if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.issues)}`);
      return { name, model: result.value as CredentialModel, signer: signers[i] };
    });
    for (const { model, signer } of models) await registry.registerIssuer(model.issuer, signer.address, 900n);
    return { registry, domain, models };
  }

  it("issues an event attendance, a course completion and a professional certification", async function () {
    const { registry, domain, models } = await loadFixture(deployFixture);
    for (const [i, { name, model, signer }] of models.entries()) {
      const signedAt = BigInt(await time.latest());
      const event = toCredentialEvent(model, { signedAt, validUntil: signedAt + 600n, submitter: ZeroAddress });
      const signature = await signer.signTypedData(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event);
      const hcs = { sequence: BigInt(i + 1), consensusTimestampNs: signedAt * 1_000_000_000n };

      expect(await registry.issue.staticCall(event, signature, hcs), name).to.equal(model.credentialId);
      await expect(registry.issue(event, signature, hcs))
        .to.emit(registry, "CredentialIssued")
        .withArgs(
          model.credentialId,
          model.issuer,
          model.subjectCommitment,
          model.credentialHash,
          model.schemaId,
          await registry.hashCredentialEvent(event),
          signer.address,
          signedAt,
          hcs.sequence,
          hcs.consensusTimestampNs,
        );

      const record = await registry.statusOf(model.credentialId);
      expect(record.issuer).to.equal(model.issuer);
      expect(record.credentialHash).to.equal(model.credentialHash);
      expect(record.subjectCommitment).to.equal(model.subjectCommitment);
      expect(record.status).to.equal(1n);
    }
  });

  it("treats a re-signed issuance of the same document as a duplicate, not a new credential", async function () {
    const { registry, domain, models } = await loadFixture(deployFixture);
    const { model, signer } = models[0];
    const sign = async (signedAt: bigint) => {
      const event = toCredentialEvent(model, { signedAt, validUntil: signedAt + 600n, submitter: ZeroAddress });
      return { event, signature: await signer.signTypedData(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event) };
    };
    const now = BigInt(await time.latest());
    const first = await sign(now);
    await registry.issue(first.event, first.signature, { sequence: 1n, consensusTimestampNs: 1n });
    const second = await sign(now + 1n);
    await expect(
      registry.issue(second.event, second.signature, { sequence: 2n, consensusTimestampNs: 2n }),
    ).to.be.revertedWithCustomError(registry, "AlreadyIssued");
  });
});
