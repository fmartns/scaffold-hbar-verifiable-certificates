import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrivateKey } from "@hashgraph/sdk";
import type { Agent } from "@credo-ts/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryHedera, importIssuerDid } from "../testing/hedera";
import { openAgent } from "./agents";
import type { CertificatesConfig } from "./config";
import { CertificateError } from "./errors";
import { initializeIssuer, issueCertificate, revokeCertificate } from "./issuer";
import type { IssuedCertificate } from "./issuer";
import { fetchHcs1File } from "./ledger";
import { ENROLLMENT_POLICY, decideEnrollment, verifyDownloadedCertificate } from "./platform";
import { createPresentation, verifyPresentation } from "./presentation";
import { enrollmentRequest } from "./platform";
import { CertificateStore } from "./store";
import type { IssuerRecord } from "./store";

const hedera = new InMemoryHedera();
const config: CertificatesConfig = {
  network: "testnet",
  operatorId: "0.0.2",
  operatorKeyDer: PrivateKey.generateED25519().toStringDer(),
  mirrorNodeUrl: hedera.mirrorNodeUrl,
  hashscanUrl: "https://hashscan.io/testnet",
  dataDir: mkdtempSync(path.join(tmpdir(), "certificates-")),
  publicUrl: "http://localhost:3000",
};
const store = new CertificateStore(config.dataDir);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let issuer: Agent, ana: Agent, bob: Agent, carol: Agent, platform: Agent;
let issuerRecord: IssuerRecord;
let anaCertificate: IssuedCertificate;

const issueTo = (holder: Agent, holderLabel: string, holderName: string, grade: number) =>
  issueCertificate(
    { config, store, issuer, holder, holderLabel },
    { holderName, studentId: "123456", course: ENROLLMENT_POLICY.prerequisite, grade },
    { publishFile: hedera.publishFile },
  );
const enroll = (holder: Agent, credentialId: string | undefined, asOf = nowSeconds()) =>
  decideEnrollment(
    { holder, credentialId, verifier: platform, trustedCredentialDefinitionId: issuerRecord.credentialDefinitionId },
    asOf,
  );

beforeAll(async () => {
  hedera.install();
  [issuer, ana, bob, carol, platform] = await Promise.all(
    ["issuer", "ana", "bob", "carol", "platform"].map(label => openAgent(config, label, { inMemory: true })),
  );
  issuerRecord = await initializeIssuer(issuer, store, config.network, {
    maximumCredentialNumber: 10,
    createDid: importIssuerDid,
  });
  anaCertificate = await issueTo(ana, "ana", "Ana Example", 88);
}, 120_000);

afterAll(async () => {
  await Promise.all([issuer, ana, bob, carol, platform].map(agent => agent?.shutdown()));
});

describe("issuer on the Hedera Verifiable Data Registry", () => {
  it("publishes schema, credential definition and revocation registry that any agent resolves from Hedera", async () => {
    const { schema } = await platform.modules.anoncreds.getSchema(issuerRecord.schemaId);
    const { credentialDefinition } = await platform.modules.anoncreds.getCredentialDefinition(
      issuerRecord.credentialDefinitionId,
    );
    const { revocationRegistryDefinition } = await platform.modules.anoncreds.getRevocationRegistryDefinition(
      issuerRecord.revocationRegistryId,
    );
    expect(schema?.attrNames).toContain("document_sha256");
    expect(credentialDefinition?.issuerId).toBe(issuerRecord.issuerDid);
    expect(revocationRegistryDefinition?.credDefId).toBe(issuerRecord.credentialDefinitionId);
  });

  it("is idempotent: a second initialization returns the published identifiers", async () => {
    const { issuerDid, schemaId, credentialDefinitionId, revocationRegistryId } = issuerRecord;
    await expect(
      initializeIssuer(issuer, store, config.network, { createDid: importIssuerDid }),
    ).resolves.toMatchObject({ issuerDid, schemaId, credentialDefinitionId, revocationRegistryId });
  });

  it("stores the PDF as an HCS-1 file whose hash is the credential's document_sha256", async () => {
    const file = await fetchHcs1File(hedera.mirrorNodeUrl, anaCertificate.record.documentTopicId, hedera.fetch);
    expect(file.mimeType).toBe("application/pdf");
    expect(Buffer.from(file.bytes).equals(Buffer.from(anaCertificate.pdf))).toBe(true);
    expect(anaCertificate.credential.values.document_sha256.raw).toBe(file.sha256);
    expect(anaCertificate.record.documentSha256).toBe(file.sha256);
  });

  it("refuses to issue before the issuer is initialized", async () => {
    const empty = new CertificateStore(mkdtempSync(path.join(tmpdir(), "empty-")));
    await expect(
      issueCertificate(
        { config, store: empty, issuer, holder: ana, holderLabel: "ana" },
        { holderName: "A", studentId: "1", course: "C", grade: 1 },
      ),
    ).rejects.toMatchObject({ code: "ISSUER_NOT_INITIALIZED" });
  });

  it("rejects invalid input before touching Hedera", async () => {
    await expect(issueTo(ana, "ana", "Ana", 101)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("Platform B enrollment in Advanced Solidity", () => {
  it("enrolls the holder of a valid Basics certificate and learns only the course and the predicate", async () => {
    const decision = await enroll(ana, anaCertificate.record.credentialId);
    expect(decision.approved).toBe(true);
    expect(decision.verification?.revealed).toEqual({ course: "Solidity Basics" });
    expect(decision.verification?.predicates).toEqual(["grade >= 70"]);
    const proof = JSON.stringify(await createPresentation(ana, anaCertificate.record.credentialId, decision.request));
    for (const secret of ["Ana Example", "123456", '"88"', anaCertificate.record.documentSha256]) {
      expect(proof).not.toContain(secret);
    }
  });

  it("denies a grade below 70: the holder cannot build the proof", async () => {
    const carolCertificate = await issueTo(carol, "carol", "Carol Example", 68);
    const decision = await enroll(carol, carolCertificate.record.credentialId);
    expect(decision.approved).toBe(false);
    expect(decision.verification).toBeUndefined();
  });

  it("denies someone who only has a copy of the PDF (no credential in their wallet)", async () => {
    const decision = await enroll(bob, undefined);
    expect(decision).toMatchObject({ approved: false, reasons: ["The holder has no certificate to present."] });
  });

  it("a copied credential is useless without the holder's link secret", async () => {
    await bob.modules.anoncreds.createLinkSecret({ setAsDefault: true });
    const { credentialDefinition } = await bob.modules.anoncreds.getCredentialDefinition(
      issuerRecord.credentialDefinitionId,
    );
    const { schema } = await bob.modules.anoncreds.getSchema(issuerRecord.schemaId);
    const { revocationRegistryDefinition } = await bob.modules.anoncreds.getRevocationRegistryDefinition(
      issuerRecord.revocationRegistryId,
    );
    const { AnonCredsHolderServiceSymbol } = await import("@credo-ts/anoncreds");
    const holderService =
      bob.dependencyManager.resolve<import("@credo-ts/anoncreds").AnonCredsHolderService>(AnonCredsHolderServiceSymbol);
    await expect(
      holderService.storeCredential(bob.context, {
        credential: anaCertificate.credential,
        credentialRequestMetadata: {
          link_secret_blinding_data: { v_prime: "1", vr_prime: null },
          link_secret_name: "x",
          nonce: "1",
        },
        credentialDefinition: credentialDefinition!,
        schema: schema!,
        credentialDefinitionId: issuerRecord.credentialDefinitionId,
        revocationRegistry: { id: issuerRecord.revocationRegistryId, definition: revocationRegistryDefinition! },
      }),
    ).rejects.toThrow();
  });

  it("rejects a proof built against a revocation state from another time than requested", async () => {
    const earlier = enrollmentRequest(issuerRecord.credentialDefinitionId, nowSeconds() - 60);
    const proof = await createPresentation(ana, anaCertificate.record.credentialId, earlier);
    const now = enrollmentRequest(issuerRecord.credentialDefinitionId, nowSeconds());
    const verification = await verifyPresentation(platform, now, proof);
    expect(verification.verified).toBe(false);
  });
});

describe("downloaded document and revocation", () => {
  it("matches the exact PDF and rejects a modified one", async () => {
    const context = {
      holder: ana,
      credentialId: anaCertificate.record.credentialId,
      verifier: platform,
      trustedCredentialDefinitionId: issuerRecord.credentialDefinitionId,
    };
    const genuine = await verifyDownloadedCertificate(context, anaCertificate.pdf, nowSeconds());
    expect(genuine).toMatchObject({ approved: true, documentMatches: true });
    expect(genuine.verification?.revealed.certificate_id).toBe(anaCertificate.record.certificateId);

    const tampered = Uint8Array.from(anaCertificate.pdf);
    tampered[tampered.length - 10] ^= 1;
    const forged = await verifyDownloadedCertificate(context, tampered, nowSeconds());
    expect(forged).toMatchObject({ approved: false, documentMatches: false });
    expect(forged.verification?.verified).toBe(true);
  });

  it("after revocation: denied now, still valid before, and the PDF stays intact", async () => {
    const before = nowSeconds();
    await pause(1100);
    const revoked = await revokeCertificate(issuer, store, anaCertificate.record.certificateId);
    expect(revoked.revokedAt).toBeDefined();
    await pause(1100);

    const now = await enroll(ana, anaCertificate.record.credentialId);
    expect(now.approved).toBe(false);
    expect(now.verification?.verified).toBe(false);

    const historical = await enroll(ana, anaCertificate.record.credentialId, before);
    expect(historical.approved).toBe(true);

    const document = await verifyDownloadedCertificate(
      {
        holder: ana,
        credentialId: anaCertificate.record.credentialId,
        verifier: platform,
        trustedCredentialDefinitionId: issuerRecord.credentialDefinitionId,
      },
      anaCertificate.pdf,
      nowSeconds(),
    );
    expect(document).toMatchObject({ documentMatches: true, approved: false });

    const file = await fetchHcs1File(hedera.mirrorNodeUrl, anaCertificate.record.documentTopicId, hedera.fetch);
    expect(file.sha256).toBe(anaCertificate.record.documentSha256);
  });

  it("revocation is state on HCS: one entry per change on the issuer's entries topic", () => {
    expect(hedera.messages(issuerRecord.revocationEntriesTopicId)).toHaveLength(2); // initial list + revocation
  });

  it("revoking twice is a no-op and an unknown certificate is NOT_FOUND", async () => {
    await expect(revokeCertificate(issuer, store, anaCertificate.record.certificateId)).resolves.toMatchObject({
      certificateId: anaCertificate.record.certificateId,
    });
    expect(hedera.messages(issuerRecord.revocationEntriesTopicId)).toHaveLength(2);
    await expect(revokeCertificate(issuer, store, "missing")).rejects.toBeInstanceOf(CertificateError);
  });
});
