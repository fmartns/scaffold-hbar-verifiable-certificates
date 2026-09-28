import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { AbiCoder, Signature, TypedDataEncoder, ZeroAddress, ZeroHash, id, keccak256 } from "ethers";
import type { CredentialRegistry } from "../typechain-types";

const TYPES = {
  CredentialEvent: [
    { name: "version", type: "uint16" },
    { name: "issuer", type: "bytes32" },
    { name: "externalCredentialId", type: "bytes32" },
    { name: "credentialHash", type: "bytes32" },
    { name: "subjectCommitment", type: "bytes32" },
    { name: "schemaId", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "submitter", type: "address" },
  ],
};

const ISSUER = id("acme-university");
const OTHER_ISSUER = id("other-org");
const MAX_VALIDITY = 900n;
const HCS_TOPIC_NUM = 4242n;
const HCS = { sequence: 7n, consensusTimestampNs: 1_700_000_000_123_456_789n };
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

interface CredentialEvent {
  version: number;
  issuer: string;
  externalCredentialId: string;
  credentialHash: string;
  subjectCommitment: string;
  schemaId: string;
  signedAt: bigint;
  validUntil: bigint;
  submitter: string;
}

async function domainOf(registry: CredentialRegistry) {
  return {
    name: "HederaVerifiableCredentials",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await registry.getAddress(),
  };
}

async function sign(registry: CredentialRegistry, signer: HardhatEthersSigner, event: CredentialEvent) {
  return signer.signTypedData(await domainOf(registry), TYPES, event);
}

function credentialIdOf(issuer: string, externalCredentialId: string): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32"],
      [id("hedera-verifiable-credentials.credential.v1"), issuer, externalCredentialId],
    ),
  );
}

describe("CredentialRegistry", function () {
  async function deployFixture() {
    const [admin, issuerSigner, otherIssuerSigner, relayer, stranger, newSigner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("CredentialRegistry");
    const registry = await factory.deploy(admin.address, HCS_TOPIC_NUM);
    await registry.registerIssuer(ISSUER, issuerSigner.address, MAX_VALIDITY);
    await registry.registerIssuer(OTHER_ISSUER, otherIssuerSigner.address, MAX_VALIDITY);
    const now = BigInt(await time.latest());

    const event = (overrides: Partial<CredentialEvent> = {}): CredentialEvent => ({
      version: 1,
      issuer: ISSUER,
      externalCredentialId: id("diploma:2026:0001"),
      credentialHash: id("credential-document-v1"),
      subjectCommitment: id("salted-subject-commitment"),
      schemaId: id("schema:diploma:v1"),
      signedAt: now,
      validUntil: now + 600n,
      submitter: ZeroAddress,
      ...overrides,
    });

    return { registry, admin, issuerSigner, otherIssuerSigner, relayer, stranger, newSigner, event };
  }

  async function issuedFixture() {
    const f = await deployFixture();
    const e = f.event();
    await f.registry.connect(f.relayer).issue(e, await sign(f.registry, f.issuerSigner, e), HCS);
    return { ...f, issued: e, credentialId: credentialIdOf(e.issuer, e.externalCredentialId) };
  }

  describe("deployment", function () {
    it("grants the admin roles and pins the HCS topic", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await registry.hasRole(await registry.ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await registry.hcsTopicNum()).to.equal(HCS_TOPIC_NUM);
      expect(await registry.paused()).to.equal(false);
    });

    it("rejects a zero admin", async function () {
      const factory = await ethers.getContractFactory("CredentialRegistry");
      await expect(factory.deploy(ZeroAddress, HCS_TOPIC_NUM))
        .to.be.revertedWithCustomError(factory, "InvalidField")
        .withArgs(ethers.encodeBytes32String("admin"));
    });
  });

  describe("identifiers", function () {
    it("pins the EIP-712 digest to the off-chain typed-data encoding", async function () {
      const { registry, event } = await loadFixture(deployFixture);
      const e = event();
      expect(await registry.hashCredentialEvent(e)).to.equal(TypedDataEncoder.hash(await domainOf(registry), TYPES, e));
    });

    it("derives credentialId from issuer and externalCredentialId only", async function () {
      const { registry } = await loadFixture(deployFixture);
      const ext = id("diploma:2026:0001");
      expect(await registry.computeCredentialId(ISSUER, ext)).to.equal(credentialIdOf(ISSUER, ext));
      expect(await registry.computeCredentialId(OTHER_ISSUER, ext)).to.not.equal(credentialIdOf(ISSUER, ext));
    });
  });

  describe("issue", function () {
    it("records a valid issuance submitted by any relayer and emits CredentialIssued", async function () {
      const { registry, issuerSigner, relayer, event } = await loadFixture(deployFixture);
      const e = event();
      const signature = await sign(registry, issuerSigner, e);
      const credentialId = credentialIdOf(e.issuer, e.externalCredentialId);
      const digest = TypedDataEncoder.hash(await domainOf(registry), TYPES, e);

      expect(await registry.connect(relayer).issue.staticCall(e, signature, HCS)).to.equal(credentialId);
      await expect(registry.connect(relayer).issue(e, signature, HCS))
        .to.emit(registry, "CredentialIssued")
        .withArgs(
          credentialId,
          e.issuer,
          e.subjectCommitment,
          e.credentialHash,
          e.schemaId,
          digest,
          issuerSigner.address,
          e.signedAt,
          HCS.sequence,
          HCS.consensusTimestampNs,
        );

      const record = await registry.statusOf(credentialId);
      expect(record.status).to.equal(1n);
      expect(record.issuer).to.equal(e.issuer);
      expect(record.credentialHash).to.equal(e.credentialHash);
      expect(record.subjectCommitment).to.equal(e.subjectCommitment);
      expect(record.signer).to.equal(issuerSigner.address);
      expect(record.issuedAt).to.equal(BigInt(await time.latest()));
      expect(record.revokedAt).to.equal(0n);
    });

    it("reports an unseen credential as status None", async function () {
      const { registry } = await loadFixture(deployFixture);
      expect((await registry.statusOf(id("never-issued"))).status).to.equal(0n);
    });

    it("rejects an unregistered issuer", async function () {
      const { registry, issuerSigner, event } = await loadFixture(deployFixture);
      const e = event({ issuer: id("unregistered-org") });
      await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
        .to.be.revertedWithCustomError(registry, "UnknownIssuer")
        .withArgs(e.issuer);
    });

    it("rejects an inactive issuer", async function () {
      const { registry, issuerSigner, event } = await loadFixture(deployFixture);
      await registry.setIssuerActive(ISSUER, false);
      const e = event();
      await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
        .to.be.revertedWithCustomError(registry, "InactiveIssuer")
        .withArgs(ISSUER);
    });

    describe("authenticity", function () {
      it("rejects a signature by a key that is not the issuer's signer", async function () {
        const { registry, issuerSigner, stranger, event } = await loadFixture(deployFixture);
        const e = event();
        await expect(registry.issue(e, await sign(registry, stranger, e), HCS))
          .to.be.revertedWithCustomError(registry, "UnauthorizedSigner")
          .withArgs(stranger.address, issuerSigner.address);
      });

      it("rejects another registered issuer signing under this namespace", async function () {
        const { registry, otherIssuerSigner, event } = await loadFixture(deployFixture);
        const e = event();
        await expect(registry.issue(e, await sign(registry, otherIssuerSigner, e), HCS)).to.be.revertedWithCustomError(
          registry,
          "UnauthorizedSigner",
        );
      });

      it("rejects a payload tampered after signing", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const e = event();
        const signature = await sign(registry, issuerSigner, e);
        await expect(
          registry.issue({ ...e, credentialHash: id("forged-document") }, signature, HCS),
        ).to.be.revertedWithCustomError(registry, "UnauthorizedSigner");
      });

      it("rejects malformed and high-s (malleable) signatures", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const e = event();
        const sig = Signature.from(await sign(registry, issuerSigner, e));
        const highS = ethers.concat([
          sig.r,
          ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32),
          sig.v === 27 ? "0x1c" : "0x1b",
        ]);

        await expect(registry.issue(e, "0x1234", HCS)).to.be.revertedWithCustomError(registry, "InvalidSignature");
        await expect(registry.issue(e, highS, HCS)).to.be.revertedWithCustomError(registry, "InvalidSignature");
      });

      it("rejects a signature bound to another deployment (cross-domain replay)", async function () {
        const { registry, admin, issuerSigner, event } = await loadFixture(deployFixture);
        const factory = await ethers.getContractFactory("CredentialRegistry");
        const other = await factory.deploy(admin.address, HCS_TOPIC_NUM);
        await other.registerIssuer(ISSUER, issuerSigner.address, MAX_VALIDITY);
        const e = event();
        const signatureForOther = await sign(other, issuerSigner, e);

        await expect(registry.issue(e, signatureForOther, HCS)).to.be.revertedWithCustomError(
          registry,
          "UnauthorizedSigner",
        );
      });
    });

    describe("re-issuance and duplication", function () {
      it("reverts AlreadyIssued when the same signed issuance is submitted again", async function () {
        const { registry, issuerSigner, stranger, issued, credentialId } = await loadFixture(issuedFixture);
        const issuedAt = (await registry.statusOf(credentialId)).issuedAt;
        await expect(registry.connect(stranger).issue(issued, await sign(registry, issuerSigner, issued), HCS))
          .to.be.revertedWithCustomError(registry, "AlreadyIssued")
          .withArgs(credentialId, issuedAt);
      });

      it("reverts AlreadyIssued for a re-signed issuance with the same content", async function () {
        const { registry, issuerSigner, issued, credentialId } = await loadFixture(issuedFixture);
        const resigned = { ...issued, signedAt: issued.signedAt + 5n, validUntil: issued.validUntil + 5n };
        await expect(
          registry.issue(resigned, await sign(registry, issuerSigner, resigned), { ...HCS, sequence: 8n }),
        ).to.be.revertedWithCustomError(registry, "AlreadyIssued");
        expect((await registry.statusOf(credentialId)).credentialHash).to.equal(issued.credentialHash);
      });

      it("reverts ConflictingCredential when the issuer signs a different hash for the same credentialId", async function () {
        const { registry, issuerSigner, issued, credentialId } = await loadFixture(issuedFixture);
        const conflicting = { ...issued, credentialHash: id("credential-document-v2") };
        await expect(registry.issue(conflicting, await sign(registry, issuerSigner, conflicting), HCS))
          .to.be.revertedWithCustomError(registry, "ConflictingCredential")
          .withArgs(credentialId, issued.credentialHash, conflicting.credentialHash);
        expect((await registry.statusOf(credentialId)).credentialHash).to.equal(issued.credentialHash);
      });

      it("reverts ConflictingCredential when the subject differs for the same credentialId", async function () {
        const { registry, issuerSigner, issued } = await loadFixture(issuedFixture);
        const conflicting = { ...issued, subjectCommitment: id("another-subject") };
        await expect(
          registry.issue(conflicting, await sign(registry, issuerSigner, conflicting), HCS),
        ).to.be.revertedWithCustomError(registry, "ConflictingCredential");
      });

      it("checks authenticity before uniqueness: an unsigned conflict is UnauthorizedSigner, not ConflictingCredential", async function () {
        const { registry, stranger, issued } = await loadFixture(issuedFixture);
        const forged = { ...issued, credentialHash: id("forged-document") };
        await expect(registry.issue(forged, await sign(registry, stranger, forged), HCS)).to.be.revertedWithCustomError(
          registry,
          "UnauthorizedSigner",
        );
      });

      it("never re-issues a revoked credentialId", async function () {
        const { registry, issuerSigner, issued, credentialId } = await loadFixture(issuedFixture);
        await registry.connect(issuerSigner).revoke(credentialId);
        await expect(
          registry.issue(issued, await sign(registry, issuerSigner, issued), HCS),
        ).to.be.revertedWithCustomError(registry, "AlreadyIssued");
        expect((await registry.statusOf(credentialId)).status).to.equal(2n);
      });

      it("keeps credentials of different issuers with the same externalCredentialId apart", async function () {
        const { registry, otherIssuerSigner, issued } = await loadFixture(issuedFixture);
        const e = { ...issued, issuer: OTHER_ISSUER };
        await expect(registry.issue(e, await sign(registry, otherIssuerSigner, e), HCS)).to.emit(
          registry,
          "CredentialIssued",
        );
      });
    });

    describe("structure", function () {
      it("rejects an unsupported version", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const e = event({ version: 2 });
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
          .to.be.revertedWithCustomError(registry, "UnsupportedVersion")
          .withArgs(2);
      });

      for (const field of [
        "issuer",
        "externalCredentialId",
        "credentialHash",
        "subjectCommitment",
        "schemaId",
      ] as const) {
        it(`rejects a zero ${field}`, async function () {
          const { registry, issuerSigner, event } = await loadFixture(deployFixture);
          const e = event({ [field]: ZeroHash });
          await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
            .to.be.revertedWithCustomError(registry, "InvalidField")
            .withArgs(ethers.encodeBytes32String(field));
        });
      }

      it("rejects validUntil not after signedAt", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const base = event();
        const e = event({ validUntil: base.signedAt });
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
          .to.be.revertedWithCustomError(registry, "InvalidField")
          .withArgs(ethers.encodeBytes32String("validUntil"));
      });

      it("rejects a zero HCS sequence", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const e = event();
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), { ...HCS, sequence: 0n }))
          .to.be.revertedWithCustomError(registry, "InvalidField")
          .withArgs(ethers.encodeBytes32String("hcs.sequence"));
      });

      it("enforces a pinned submitter", async function () {
        const { registry, issuerSigner, relayer, stranger, event } = await loadFixture(deployFixture);
        const e = event({ submitter: relayer.address });
        const signature = await sign(registry, issuerSigner, e);
        await expect(registry.connect(stranger).issue(e, signature, HCS))
          .to.be.revertedWithCustomError(registry, "SubmitterMismatch")
          .withArgs(relayer.address, stranger.address);
        await expect(registry.connect(relayer).issue(e, signature, HCS)).to.emit(registry, "CredentialIssued");
      });
    });

    describe("freshness", function () {
      it("rejects an expired issuance", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const e = event();
        const signature = await sign(registry, issuerSigner, e);
        await time.increaseTo(e.validUntil + 1n);
        await expect(registry.issue(e, signature, HCS)).to.be.revertedWithCustomError(registry, "Expired");
      });

      it("rejects an issuance signed in the future beyond the clock skew", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const base = event();
        const e = event({ signedAt: base.signedAt + 120n, validUntil: base.signedAt + 600n });
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS)).to.be.revertedWithCustomError(
          registry,
          "SignedInFuture",
        );
      });

      it("rejects a validity window longer than the issuer's maxValidity", async function () {
        const { registry, issuerSigner, event } = await loadFixture(deployFixture);
        const base = event();
        const e = event({ validUntil: base.signedAt + MAX_VALIDITY + 1n });
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
          .to.be.revertedWithCustomError(registry, "ValidityWindowTooLong")
          .withArgs(MAX_VALIDITY + 1n, MAX_VALIDITY);
      });
    });

    describe("pause", function () {
      it("blocks issuance but not revocation", async function () {
        const { registry, issuerSigner, event, credentialId } = await loadFixture(issuedFixture);
        await expect(registry.setPaused(true)).to.emit(registry, "PausedSet").withArgs(true);
        const e = event({ externalCredentialId: id("diploma:2026:0002") });
        await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS)).to.be.revertedWithCustomError(
          registry,
          "Paused",
        );
        await expect(registry.connect(issuerSigner).revoke(credentialId)).to.emit(registry, "CredentialRevoked");
      });

      it("can only be set by ADMIN_ROLE", async function () {
        const { registry, stranger } = await loadFixture(deployFixture);
        await expect(registry.connect(stranger).setPaused(true)).to.be.revertedWithCustomError(
          registry,
          "AccessControlUnauthorizedAccount",
        );
      });
    });
  });

  describe("revoke", function () {
    it("lets the issuing namespace's signer revoke and emits CredentialRevoked", async function () {
      const { registry, issuerSigner, credentialId, issued } = await loadFixture(issuedFixture);
      const tx = registry.connect(issuerSigner).revoke(credentialId);
      await expect(tx)
        .to.emit(registry, "CredentialRevoked")
        .withArgs(credentialId, ISSUER, issuerSigner.address, false, BigInt(await time.latest()) + 1n);

      const record = await registry.statusOf(credentialId);
      expect(record.status).to.equal(2n);
      expect(record.revokedAt).to.equal(BigInt(await time.latest()));
      expect(record.credentialHash).to.equal(issued.credentialHash);
    });

    it("rejects an unauthorized third party", async function () {
      const { registry, stranger, credentialId } = await loadFixture(issuedFixture);
      await expect(registry.connect(stranger).revoke(credentialId))
        .to.be.revertedWithCustomError(registry, "UnauthorizedRevoker")
        .withArgs(credentialId, stranger.address);
    });

    it("rejects the signer of a different issuer", async function () {
      const { registry, otherIssuerSigner, credentialId } = await loadFixture(issuedFixture);
      await expect(registry.connect(otherIssuerSigner).revoke(credentialId)).to.be.revertedWithCustomError(
        registry,
        "UnauthorizedRevoker",
      );
    });

    it("rejects the relayer that submitted the issuance", async function () {
      const { registry, relayer, credentialId } = await loadFixture(issuedFixture);
      await expect(registry.connect(relayer).revoke(credentialId)).to.be.revertedWithCustomError(
        registry,
        "UnauthorizedRevoker",
      );
    });

    it("rejects an unknown credential", async function () {
      const { registry, issuerSigner } = await loadFixture(issuedFixture);
      await expect(registry.connect(issuerSigner).revoke(id("never-issued")))
        .to.be.revertedWithCustomError(registry, "UnknownCredential")
        .withArgs(id("never-issued"));
    });

    it("rejects a second revocation", async function () {
      const { registry, issuerSigner, admin, credentialId } = await loadFixture(issuedFixture);
      await registry.connect(issuerSigner).revoke(credentialId);
      const revokedAt = (await registry.statusOf(credentialId)).revokedAt;
      await expect(registry.connect(admin).revoke(credentialId))
        .to.be.revertedWithCustomError(registry, "AlreadyRevoked")
        .withArgs(credentialId, revokedAt);
    });

    it("moves revocation power with key rotation", async function () {
      const { registry, issuerSigner, newSigner, credentialId } = await loadFixture(issuedFixture);
      await registry.connect(issuerSigner).rotateIssuerSigner(ISSUER, newSigner.address);
      await expect(registry.connect(issuerSigner).revoke(credentialId)).to.be.revertedWithCustomError(
        registry,
        "UnauthorizedRevoker",
      );
      await expect(registry.connect(newSigner).revoke(credentialId)).to.emit(registry, "CredentialRevoked");
    });

    it("denies revocation to the signer of a deactivated issuer, but not to the admin", async function () {
      const { registry, admin, issuerSigner, credentialId } = await loadFixture(issuedFixture);
      await registry.setIssuerActive(ISSUER, false);
      await expect(registry.connect(issuerSigner).revoke(credentialId)).to.be.revertedWithCustomError(
        registry,
        "UnauthorizedRevoker",
      );
      await expect(registry.connect(admin).revoke(credentialId)).to.emit(registry, "CredentialRevoked");
    });
  });

  describe("admin powers are configuration only", function () {
    it("lets ADMIN_ROLE revoke without altering the record's hash, subject, issuer or signer", async function () {
      const { registry, admin, issuerSigner, issued, credentialId } = await loadFixture(issuedFixture);
      const before = await registry.statusOf(credentialId);
      await expect(registry.connect(admin).revoke(credentialId))
        .to.emit(registry, "CredentialRevoked")
        .withArgs(credentialId, ISSUER, admin.address, true, BigInt(await time.latest()) + 1n);

      const after = await registry.statusOf(credentialId);
      expect(after.status).to.equal(2n);
      expect(after.credentialHash).to.equal(issued.credentialHash);
      expect(after.subjectCommitment).to.equal(issued.subjectCommitment);
      expect(after.issuer).to.equal(before.issuer);
      expect(after.signer).to.equal(issuerSigner.address);
      expect(after.issuedAt).to.equal(before.issuedAt);
    });

    it("cannot forge an issuance under an existing issuer with its own signature", async function () {
      const { registry, admin, issuerSigner, event } = await loadFixture(deployFixture);
      const e = event();
      await expect(registry.connect(admin).issue(e, await sign(registry, admin, e), HCS))
        .to.be.revertedWithCustomError(registry, "UnauthorizedSigner")
        .withArgs(admin.address, issuerSigner.address);
    });

    it("cannot rotate an existing issuer's signer or re-register its namespace", async function () {
      const { registry, admin } = await loadFixture(deployFixture);
      await expect(registry.connect(admin).rotateIssuerSigner(ISSUER, admin.address))
        .to.be.revertedWithCustomError(registry, "NotIssuerSigner")
        .withArgs(ISSUER, admin.address);
      await expect(registry.connect(admin).registerIssuer(ISSUER, admin.address, MAX_VALIDITY))
        .to.be.revertedWithCustomError(registry, "IssuerAlreadyRegistered")
        .withArgs(ISSUER);
    });

    it("cannot change a record by overwriting it: a conflicting issuance by the real issuer still reverts", async function () {
      const { registry, admin, issuerSigner, issued, credentialId } = await loadFixture(issuedFixture);
      await registry.connect(admin).revoke(credentialId);
      const rewritten = { ...issued, credentialHash: id("rewritten-document") };
      await expect(
        registry.issue(rewritten, await sign(registry, issuerSigner, rewritten), HCS),
      ).to.be.revertedWithCustomError(registry, "ConflictingCredential");
    });

    it("exposes no state-changing function beyond the reviewed surface", async function () {
      const { registry } = await loadFixture(deployFixture);
      const mutating = registry.interface.fragments
        .filter(f => f.type === "function")
        .map(f => f as unknown as { name: string; stateMutability: string })
        .filter(f => f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map(f => f.name)
        .sort();
      expect(mutating).to.deep.equal(
        [
          "grantRole",
          "issue",
          "registerIssuer",
          "renounceRole",
          "revoke",
          "revokeRole",
          "rotateIssuerSigner",
          "setIssuerActive",
          "setIssuerMaxValidity",
          "setPaused",
        ].sort(),
      );
    });
  });

  describe("issuer registry", function () {
    it("registers an issuer and emits IssuerRegistered", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      const ns = id("new-org");
      await expect(registry.registerIssuer(ns, stranger.address, 300n))
        .to.emit(registry, "IssuerRegistered")
        .withArgs(ns, stranger.address, 300n);
      const cfg = await registry.issuerOf(ns);
      expect(cfg.signer).to.equal(stranger.address);
      expect(cfg.active).to.equal(true);
      expect(cfg.maxValidity).to.equal(300n);
    });

    it("rejects invalid registrations", async function () {
      const { registry, stranger } = await loadFixture(deployFixture);
      const ns = id("new-org");
      await expect(registry.registerIssuer(ZeroHash, stranger.address, 300n)).to.be.revertedWithCustomError(
        registry,
        "InvalidField",
      );
      await expect(registry.registerIssuer(ns, ZeroAddress, 300n)).to.be.revertedWithCustomError(
        registry,
        "InvalidField",
      );
      await expect(registry.registerIssuer(ns, stranger.address, 0n)).to.be.revertedWithCustomError(
        registry,
        "InvalidField",
      );
      const ceiling = await registry.MAX_VALIDITY_CEILING();
      await expect(registry.registerIssuer(ns, stranger.address, ceiling + 1n)).to.be.revertedWithCustomError(
        registry,
        "InvalidField",
      );
    });

    it("restricts configuration to ADMIN_ROLE", async function () {
      const { registry, stranger, issuerSigner } = await loadFixture(deployFixture);
      await expect(
        registry.connect(stranger).registerIssuer(id("x"), stranger.address, 300n),
      ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(issuerSigner).setIssuerActive(ISSUER, false)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
      await expect(registry.connect(issuerSigner).setIssuerMaxValidity(ISSUER, 60n)).to.be.revertedWithCustomError(
        registry,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("updates active flag and maxValidity with events", async function () {
      const { registry } = await loadFixture(deployFixture);
      await expect(registry.setIssuerActive(ISSUER, false))
        .to.emit(registry, "IssuerActiveSet")
        .withArgs(ISSUER, false);
      await expect(registry.setIssuerMaxValidity(ISSUER, 60n))
        .to.emit(registry, "IssuerMaxValiditySet")
        .withArgs(ISSUER, 60n);
      await expect(registry.setIssuerActive(id("missing"), true)).to.be.revertedWithCustomError(
        registry,
        "UnknownIssuer",
      );
    });

    it("rotates the signer only by the current signer; old signatures stop working immediately", async function () {
      const { registry, issuerSigner, newSigner, event } = await loadFixture(deployFixture);
      await expect(registry.connect(issuerSigner).rotateIssuerSigner(ISSUER, newSigner.address))
        .to.emit(registry, "IssuerSignerRotated")
        .withArgs(ISSUER, issuerSigner.address, newSigner.address);

      const e = event();
      await expect(registry.issue(e, await sign(registry, issuerSigner, e), HCS))
        .to.be.revertedWithCustomError(registry, "UnauthorizedSigner")
        .withArgs(issuerSigner.address, newSigner.address);
      await expect(registry.issue(e, await sign(registry, newSigner, e), HCS)).to.emit(registry, "CredentialIssued");
    });

    it("refuses rotation by a deactivated issuer and to the zero address", async function () {
      const { registry, issuerSigner } = await loadFixture(deployFixture);
      await expect(
        registry.connect(issuerSigner).rotateIssuerSigner(ISSUER, ZeroAddress),
      ).to.be.revertedWithCustomError(registry, "InvalidField");
      await registry.setIssuerActive(ISSUER, false);
      await expect(
        registry.connect(issuerSigner).rotateIssuerSigner(ISSUER, issuerSigner.address),
      ).to.be.revertedWithCustomError(registry, "InactiveIssuer");
    });
  });
});
