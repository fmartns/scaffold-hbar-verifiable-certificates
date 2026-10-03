/**
 * One object that wires the agents, the local store and Hedera together for the app and the CLI. Server-side only:
 * it opens Askar wallets and holds the operator key. Agents are opened lazily, once per process.
 *
 * Demo roles: `issuer` (Hedera Academy), `platform` (Platform B, the verifier) and the holders `ana` and `bob`.
 */
import type { Agent } from "@credo-ts/core";
import { MirrorAccreditationReader, changeAccreditation, deployAccreditationRegistry } from "./accreditation";
import type { AccreditationReader } from "./accreditation";
import { openAgent } from "./agents";
import type { CertificatesConfig } from "./config";
import { CertificateError } from "./errors";
import { ISSUER_NAME, initializeIssuer, issueCertificate, revokeCertificate } from "./issuer";
import type { IssueCertificateInput } from "./issuer";
import { createLedgerClient, fetchHcs1File } from "./ledger";
import { ENROLLMENT_POLICY, decideEnrollment, verifyDownloadedCertificate } from "./platform";
import type { Decision, DocumentCheck } from "./platform";
import { CertificateStore } from "./store";
import type { AccreditationRecord, CertificateRecord, IssuerRecord } from "./store";

export const HOLDERS = ["ana", "bob"] as const;
export type HolderLabel = (typeof HOLDERS)[number];

export const isHolder = (value: unknown): value is HolderLabel => HOLDERS.includes(value as HolderLabel);

/** A register entry as the console shows it: the wallet record id and the revocation index stay server-side. */
export type RegisterEntry = Omit<CertificateRecord, "credentialId" | "revocationIndex">;

/** Picks the shareable fields (an allow-list, so a field added to the record later is not exposed by accident). */
export const toRegisterEntry = (record: CertificateRecord): RegisterEntry => ({
  certificateId: record.certificateId,
  holder: record.holder,
  holderName: record.holderName,
  course: record.course,
  issuedOn: record.issuedOn,
  issuedAt: record.issuedAt,
  documentTopicId: record.documentTopicId,
  documentSha256: record.documentSha256,
  ...(record.revokedAt && { revokedAt: record.revokedAt }),
});

/** What anyone may see about a certificate: no grade, no student id, no revocation index. */
export interface PublicCertificate {
  certificateId: string;
  holderName: string;
  course: string;
  issuedOn: string;
  issuerName: string;
  issuerDid: string;
  credentialDefinitionId: string;
  documentTopicId: string;
  documentSha256: string;
  /** Result of re-reading the HCS-1 file from the Mirror Node and checking it against its memo. */
  documentIntegrity: { valid: true } | { valid: false; reason: string };
  links: { documentTopic: string; documentMessages: string; issuerDid: string };
}

export class CertificateService {
  readonly store: CertificateStore;
  private readonly agents = new Map<string, Promise<Agent>>();

  constructor(readonly config: CertificatesConfig) {
    this.store = new CertificateStore(config.dataDir);
  }

  agent(label: "issuer" | "platform" | HolderLabel): Promise<Agent> {
    let agent = this.agents.get(label);
    if (!agent) {
      agent = openAgent(this.config, label);
      agent.catch(() => this.agents.delete(label));
      this.agents.set(label, agent);
    }
    return agent;
  }

  async shutdown(): Promise<void> {
    const agents = await Promise.allSettled(this.agents.values());
    this.agents.clear();
    await Promise.all(agents.map(result => (result.status === "fulfilled" ? result.value.shutdown() : undefined)));
  }

  /**
   * Publishes the issuer (DID, schema, credential definition, revocation registry), then deploys the accreditation
   * registry and accredits the issuer's credential definition for the prerequisite course. In this demo the operator
   * plays the accreditation authority too. Idempotent: each half is skipped when already done on this network.
   */
  async initialize(): Promise<{ issuer: IssuerRecord; accreditation: AccreditationRecord }> {
    const issuer = await initializeIssuer(await this.agent("issuer"), this.store, this.config.network);
    const existing = await this.store.readAccreditation();
    if (existing?.network === this.config.network) return { issuer, accreditation: existing };

    const client = createLedgerClient(this.config);
    try {
      const course = ENROLLMENT_POLICY.prerequisite;
      const registry = await deployAccreditationRegistry(client);
      const transactionId = await changeAccreditation(
        client,
        registry.contractId,
        "accredit",
        course,
        issuer.credentialDefinitionId,
      );
      const reader = new MirrorAccreditationReader(this.config.mirrorNodeUrl, registry.evmAddress);
      await waitFor(() => reader.isAccredited(course, issuer.credentialDefinitionId, Math.floor(Date.now() / 1000)));
      const accreditation: AccreditationRecord = {
        network: this.config.network,
        ...registry,
        authorityAccountId: this.config.operatorId,
        course,
        credentialDefinitionId: issuer.credentialDefinitionId,
        accreditedAt: new Date().toISOString(),
        accreditTransactionId: transactionId,
      };
      await this.store.writeAccreditation(accreditation);
      return { issuer, accreditation };
    } finally {
      client.close();
    }
  }

  private async accreditationRecord(): Promise<AccreditationRecord> {
    const record = await this.store.readAccreditation();
    if (!record || record.network !== this.config.network) {
      throw new CertificateError("ISSUER_NOT_INITIALIZED", "Run `yarn issuer:init` first.");
    }
    return record;
  }

  /** Platform B's view of the accreditation registry, read through the Mirror Node. */
  async accreditation(): Promise<AccreditationReader> {
    const record = await this.accreditationRecord();
    return new MirrorAccreditationReader(this.config.mirrorNodeUrl, record.evmAddress);
  }

  /** The authority withdraws the demo issuer's accreditation: valid certificates stop qualifying from now on. */
  async withdrawAccreditation(): Promise<AccreditationRecord> {
    const record = await this.accreditationRecord();
    if (record.withdrawnAt) return record;
    const client = createLedgerClient(this.config);
    try {
      const transactionId = await changeAccreditation(
        client,
        record.contractId,
        "withdraw",
        record.course,
        record.credentialDefinitionId,
      );
      const reader = new MirrorAccreditationReader(this.config.mirrorNodeUrl, record.evmAddress);
      const now = () => Math.floor(Date.now() / 1000);
      await waitFor(async () => !(await reader.isAccredited(record.course, record.credentialDefinitionId, now())));
      const withdrawn = { ...record, withdrawnAt: new Date().toISOString(), withdrawTransactionId: transactionId };
      await this.store.writeAccreditation(withdrawn);
      return withdrawn;
    } finally {
      client.close();
    }
  }

  private async issuerRecord(): Promise<IssuerRecord> {
    const record = await this.store.readIssuer();
    if (!record || record.network !== this.config.network) {
      throw new CertificateError("ISSUER_NOT_INITIALIZED", "Run `yarn issuer:init` (or Initialize issuer) first.");
    }
    return record;
  }

  async issue(holder: HolderLabel, input: IssueCertificateInput): Promise<CertificateRecord> {
    const [issuer, holderAgent] = await Promise.all([this.agent("issuer"), this.agent(holder)]);
    const issued = await issueCertificate(
      { config: this.config, store: this.store, issuer, holder: holderAgent, holderLabel: holder },
      input,
    );
    return issued.record;
  }

  async revoke(certificateId: string): Promise<CertificateRecord> {
    return revokeCertificate(await this.agent("issuer"), this.store, certificateId);
  }

  async certificate(certificateId: string): Promise<CertificateRecord> {
    const record = await this.store.getCertificate(certificateId);
    if (!record) throw new CertificateError("NOT_FOUND", "Unknown certificate.");
    return record;
  }

  /** The PDF, read back from HCS-1 through the Mirror Node and verified against its memo before it is served. */
  async document(certificateId: string): Promise<Uint8Array> {
    const record = await this.certificate(certificateId);
    return (await fetchHcs1File(this.config.mirrorNodeUrl, record.documentTopicId)).bytes;
  }

  async publicCertificate(certificateId: string): Promise<PublicCertificate> {
    const [record, issuer] = await Promise.all([this.certificate(certificateId), this.issuerRecord()]);
    let documentIntegrity: PublicCertificate["documentIntegrity"];
    try {
      const file = await fetchHcs1File(this.config.mirrorNodeUrl, record.documentTopicId);
      documentIntegrity =
        file.sha256 === record.documentSha256
          ? { valid: true }
          : { valid: false, reason: "The stored file is not the issued document." };
    } catch (error) {
      documentIntegrity = { valid: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const didTopic = issuer.issuerDid.split("_").pop() ?? "";
    return {
      certificateId: record.certificateId,
      holderName: record.holderName,
      course: record.course,
      issuedOn: record.issuedOn,
      issuerName: ISSUER_NAME,
      issuerDid: issuer.issuerDid,
      credentialDefinitionId: issuer.credentialDefinitionId,
      documentTopicId: record.documentTopicId,
      documentSha256: record.documentSha256,
      documentIntegrity,
      links: {
        documentTopic: `${this.config.hashscanUrl}/topic/${record.documentTopicId}`,
        documentMessages: `${this.config.mirrorNodeUrl}/api/v1/topics/${record.documentTopicId}/messages`,
        issuerDid: `${this.config.hashscanUrl}/topic/${didTopic}`,
      },
    };
  }

  /** The holder's newest certificate for `course`, if they have one. */
  private async credentialOf(holder: HolderLabel, certificateId?: string): Promise<string | undefined> {
    const records = (await this.store.listCertificates()).filter(r => r.holder === holder);
    const chosen = certificateId
      ? records.find(r => r.certificateId === certificateId)
      : records.filter(r => r.course === ENROLLMENT_POLICY.prerequisite).at(-1);
    return chosen?.credentialId;
  }

  /** Platform B decides on enrollment in Advanced Solidity from `holder`'s proof, as of `asOf` (default: now). */
  async enroll(holder: HolderLabel, asOf = Math.floor(Date.now() / 1000)): Promise<Decision> {
    const [holderAgent, platform, accreditation] = await Promise.all([
      this.agent(holder),
      this.agent("platform"),
      this.accreditation(),
    ]);
    const credentialId = await this.credentialOf(holder);
    return decideEnrollment({ holder: holderAgent, credentialId, verifier: platform, accreditation }, asOf);
  }

  /** Platform B checks that `file` is the document of `holder`'s certificate and that the credential is valid now. */
  async checkDocument(holder: HolderLabel, certificateId: string, file: Uint8Array): Promise<DocumentCheck> {
    const [holderAgent, platform, accreditation] = await Promise.all([
      this.agent(holder),
      this.agent("platform"),
      this.accreditation(),
    ]);
    const credentialId = await this.credentialOf(holder, certificateId);
    return verifyDownloadedCertificate(
      { holder: holderAgent, credentialId, verifier: platform, accreditation },
      file,
      Math.floor(Date.now() / 1000),
    );
  }
}

/** Polls `check` until it holds: Mirror Node state follows consensus by a few seconds. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) {
      throw new CertificateError("LEDGER_READ_FAILED", "The Mirror Node did not reflect the change in time.");
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
