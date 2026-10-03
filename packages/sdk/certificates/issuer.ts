/**
 * The issuer: publishes its identity and AnonCreds objects on Hedera once, then issues and revokes certificates.
 *
 * Issuing a certificate is, in order: render the PDF, store it as an HCS-1 file (its memo is the PDF's SHA-256), then
 * issue an AnonCreds credential whose `document_sha256` attribute is that same hash. The credential is the source of
 * validity; the PDF is its human-readable picture, bound to it by the hash and never by anything circular.
 */
import { randomUUID } from "node:crypto";
import { AnonCredsHolderServiceSymbol, AnonCredsIssuerServiceSymbol } from "@credo-ts/anoncreds";
import type { AnonCredsCredential, AnonCredsHolderService, AnonCredsIssuerService } from "@credo-ts/anoncreds";
import type { Agent } from "@credo-ts/core";
import type { CertificatesConfig } from "./config";
import { renderCertificatePdf } from "./document";
import { CertificateError } from "./errors";
import { sha256Hex } from "./hcs1";
import { publishHcs1File } from "./ledger";
import type { CertificateRecord, CertificateStore, IssuerRecord } from "./store";

export const ISSUER_NAME = "Hedera Academy";

/** Attributes of the `CourseCompletion` credential. Only `course` and the grade predicate are needed to enroll. */
export const CERTIFICATE_SCHEMA = {
  name: "CourseCompletion",
  version: "1.0",
  attributes: ["holder_name", "student_id", "course", "grade", "certificate_id", "document_sha256"],
} as const;

export const DEFAULT_MAXIMUM_CREDENTIAL_NUMBER = 1000;

const now = () => Math.floor(Date.now() / 1000);

/** AnonCreds raw → encoded rule: 32-bit integers stay as they are (so predicates work), anything else is hashed. */
export function encodeAttribute(raw: string): string {
  if (/^-?\d+$/.test(raw) && Math.abs(Number(raw)) < 2 ** 31) return String(Number(raw));
  return BigInt(`0x${sha256Hex(Buffer.from(raw, "utf8"))}`).toString();
}

/** Registers a new `did:hedera` (an HCS topic holding the DID document) whose root key stays in the issuer wallet. */
export async function registerIssuerDid(issuer: Agent): Promise<string> {
  const result = await issuer.dids.create({ method: "hedera" });
  if (!result.didState.did) {
    throw new CertificateError(
      "LEDGER_WRITE_FAILED",
      `Could not register the issuer DID: ${JSON.stringify(result.didState)}`,
    );
  }
  return result.didState.did;
}

/**
 * Publishes the issuer's DID, the schema, a revocable credential definition and a revocation registry on Hedera.
 * Idempotent: an issuer that is already initialized on this network is returned as is.
 */
export async function initializeIssuer(
  issuer: Agent,
  store: CertificateStore,
  network: string,
  options: { maximumCredentialNumber?: number; createDid?: (issuer: Agent) => Promise<string> } = {},
): Promise<IssuerRecord> {
  const { maximumCredentialNumber = DEFAULT_MAXIMUM_CREDENTIAL_NUMBER, createDid = registerIssuerDid } = options;
  const existing = await store.readIssuer();
  if (existing?.network === network) return existing;

  const fail = (step: string, detail: unknown): never => {
    throw new CertificateError(
      "LEDGER_WRITE_FAILED",
      `Could not publish the ${step} on Hedera: ${JSON.stringify(detail)}`,
    );
  };

  const issuerDid = await createDid(issuer);

  const schema = await issuer.modules.anoncreds.registerSchema({
    schema: {
      name: CERTIFICATE_SCHEMA.name,
      version: CERTIFICATE_SCHEMA.version,
      issuerId: issuerDid,
      attrNames: [...CERTIFICATE_SCHEMA.attributes],
    },
    options: {},
  });
  const schemaId = schema.schemaState.schemaId ?? fail("schema", schema.schemaState);

  const definition = await issuer.modules.anoncreds.registerCredentialDefinition({
    credentialDefinition: { tag: "course-completion", issuerId: issuerDid, schemaId },
    options: { supportRevocation: true },
  });
  const credentialDefinitionId =
    definition.credentialDefinitionState.credentialDefinitionId ??
    fail("credential definition", definition.credentialDefinitionState);

  const registry = await issuer.modules.anoncreds.registerRevocationRegistryDefinition({
    revocationRegistryDefinition: { issuerId: issuerDid, credentialDefinitionId, maximumCredentialNumber, tag: "r1" },
    options: {},
  });
  const revocationRegistryId =
    registry.revocationRegistryDefinitionState.revocationRegistryDefinitionId ??
    fail("revocation registry", registry.revocationRegistryDefinitionState);

  const statusList = await issuer.modules.anoncreds.registerRevocationStatusList({
    revocationStatusList: { issuerId: issuerDid, revocationRegistryDefinitionId: revocationRegistryId },
    options: {},
  });
  if (statusList.revocationStatusListState.state !== "finished")
    fail("revocation status list", statusList.revocationStatusListState);

  const record: IssuerRecord = {
    network,
    issuerDid,
    schemaId,
    credentialDefinitionId,
    revocationRegistryId,
    revocationEntriesTopicId: String(registry.revocationRegistryDefinitionMetadata.entriesTopicId),
    maximumCredentialNumber,
    nextRevocationIndex: 1,
    createdAt: new Date().toISOString(),
  };
  await store.writeIssuer(record);
  return record;
}

export interface IssueCertificateInput {
  holderName: string;
  studentId: string;
  course: string;
  grade: number;
}

export interface IssuedCertificate {
  record: CertificateRecord;
  pdf: Uint8Array;
  /** The signed credential as the holder received it (tests use it to show a copy is useless without the link secret). */
  credential: AnonCredsCredential;
}

export function validateIssueInput(input: IssueCertificateInput): void {
  const text = (value: string, name: string) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 80) {
      throw new CertificateError("INVALID_INPUT", `${name} must be 1 to 80 characters.`);
    }
  };
  text(input.holderName, "holderName");
  text(input.studentId, "studentId");
  text(input.course, "course");
  if (!Number.isInteger(input.grade) || input.grade < 0 || input.grade > 100) {
    throw new CertificateError("INVALID_INPUT", "grade must be an integer from 0 to 100.");
  }
}

/** Issues a certificate to `holder`: PDF on HCS-1 first, then the credential that commits to the PDF's hash. */
export async function issueCertificate(
  context: { config: CertificatesConfig; store: CertificateStore; issuer: Agent; holder: Agent; holderLabel: string },
  input: IssueCertificateInput,
  dependencies: { publishFile?: typeof publishHcs1File } = {},
): Promise<IssuedCertificate> {
  validateIssueInput(input);
  const { config, store, issuer, holder, holderLabel } = context;
  const issuerRecord = await store.readIssuer();
  if (!issuerRecord) throw new CertificateError("ISSUER_NOT_INITIALIZED", "Run `yarn issuer:init` first.");
  const revocationIndex = issuerRecord.nextRevocationIndex;
  if (revocationIndex >= issuerRecord.maximumCredentialNumber) {
    throw new CertificateError("REGISTRY_FULL", "The revocation registry has no free index left.");
  }

  const certificateId = randomUUID();
  const issuedOn = new Date().toISOString().slice(0, 10);
  const pdf = await renderCertificatePdf({
    certificateId,
    holderName: input.holderName,
    course: input.course,
    issuerName: ISSUER_NAME,
    issuedOn,
    verificationUrl: `${config.publicUrl}/certificate/${certificateId}`,
  });
  const document = await (dependencies.publishFile ?? publishHcs1File)(config, pdf, "application/pdf");

  const issuerService = issuer.dependencyManager.resolve<AnonCredsIssuerService>(AnonCredsIssuerServiceSymbol);
  const holderService = holder.dependencyManager.resolve<AnonCredsHolderService>(AnonCredsHolderServiceSymbol);
  const { credentialDefinitionId, schemaId, revocationRegistryId } = issuerRecord;

  const linkSecretIds = await holder.modules.anoncreds.getLinkSecretIds();
  const linkSecretId = linkSecretIds[0] ?? (await holder.modules.anoncreds.createLinkSecret({ setAsDefault: true }));

  // The holder resolves everything it needs from Hedera, not from the issuer.
  const { credentialDefinition } = await holder.modules.anoncreds.getCredentialDefinition(credentialDefinitionId);
  const { schema } = await holder.modules.anoncreds.getSchema(schemaId);
  const { revocationRegistryDefinition } =
    await holder.modules.anoncreds.getRevocationRegistryDefinition(revocationRegistryId);
  if (!credentialDefinition || !schema || !revocationRegistryDefinition) {
    throw new CertificateError("LEDGER_READ_FAILED", "Could not resolve the issuer's AnonCreds objects from Hedera.");
  }

  const offer = await issuerService.createCredentialOffer(issuer.context, { credentialDefinitionId });
  const { credentialRequest, credentialRequestMetadata } = await holderService.createCredentialRequest(holder.context, {
    credentialOffer: offer,
    credentialDefinition,
    linkSecretId,
  });
  const { revocationStatusList } = await issuer.modules.anoncreds.getRevocationStatusList(revocationRegistryId, now());
  if (!revocationStatusList)
    throw new CertificateError("LEDGER_READ_FAILED", "Could not read the revocation state from Hedera.");

  const raw: Record<(typeof CERTIFICATE_SCHEMA.attributes)[number], string> = {
    holder_name: input.holderName,
    student_id: input.studentId,
    course: input.course,
    grade: String(input.grade),
    certificate_id: certificateId,
    document_sha256: document.sha256,
  };
  const credentialValues = Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, { raw: value, encoded: encodeAttribute(value) }]),
  );
  const { credential } = await issuerService.createCredential(issuer.context, {
    credentialOffer: offer,
    credentialRequest,
    credentialValues,
    revocationRegistryDefinitionId: revocationRegistryId,
    revocationStatusList,
    revocationRegistryIndex: revocationIndex,
  });

  const credentialId = await holderService.storeCredential(holder.context, {
    credential,
    credentialRequestMetadata,
    credentialDefinition,
    schema,
    credentialDefinitionId,
    revocationRegistry: { id: revocationRegistryId, definition: revocationRegistryDefinition },
  });

  const record: CertificateRecord = {
    certificateId,
    holder: holderLabel,
    holderName: input.holderName,
    course: input.course,
    issuedOn,
    issuedAt: new Date().toISOString(),
    documentTopicId: document.topicId,
    documentSha256: document.sha256,
    revocationIndex,
    credentialId,
  };
  await store.writeIssuer({ ...issuerRecord, nextRevocationIndex: revocationIndex + 1 });
  await store.putCertificate(record);
  return { record, pdf, credential };
}

/** Revokes a certificate: one HCS message on the revocation entries topic. The PDF is left untouched. */
export async function revokeCertificate(
  issuer: Agent,
  store: CertificateStore,
  certificateId: string,
): Promise<CertificateRecord> {
  const issuerRecord = await store.readIssuer();
  if (!issuerRecord) throw new CertificateError("ISSUER_NOT_INITIALIZED", "Run `yarn issuer:init` first.");
  const record = await store.getCertificate(certificateId);
  if (!record) throw new CertificateError("NOT_FOUND", "Unknown certificate.");
  if (record.revokedAt) return record;

  const result = await issuer.modules.anoncreds.updateRevocationStatusList({
    revocationStatusList: {
      revocationRegistryDefinitionId: issuerRecord.revocationRegistryId,
      revokedCredentialIndexes: [record.revocationIndex],
    },
    options: {},
  });
  if (result.revocationStatusListState.state !== "finished") {
    throw new CertificateError("LEDGER_WRITE_FAILED", "Hedera did not accept the revocation entry.");
  }
  const revoked = { ...record, revokedAt: new Date().toISOString() };
  await store.putCertificate(revoked);
  return revoked;
}
