/**
 * Local state of the demo deployment, kept as JSON next to the wallets in `dataDir` (git-ignored):
 *
 * - `issuer.json`: the public identifiers the issuer published on Hedera (DID, schema, credential definition,
 *   revocation registry) and the next free revocation index.
 * - `accreditation.json`: the accreditation registry contract and the accreditation granted to the demo issuer.
 * - `certificates.json`: the issuer's register of what it issued. It holds no grade or student id (those exist only in
 *   the holder's credential) and it is never the source of validity: that is the revocation state on Hedera.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface IssuerRecord {
  network: string;
  issuerDid: string;
  schemaId: string;
  credentialDefinitionId: string;
  revocationRegistryId: string;
  /** HCS topic whose messages are the revocation registry entries (the state verifiers rebuild). */
  revocationEntriesTopicId: string;
  maximumCredentialNumber: number;
  /** Next revocation index to assign. AnonCreds accepts 1 … maximumCredentialNumber − 1. */
  nextRevocationIndex: number;
  createdAt: string;
}

export interface CertificateRecord {
  certificateId: string;
  /** Wallet label of the holder agent that received the credential. */
  holder: string;
  holderName: string;
  course: string;
  issuedOn: string;
  issuedAt: string;
  /** HCS-1 topic holding the PDF. */
  documentTopicId: string;
  documentSha256: string;
  revocationIndex: number;
  /** Id of the credential in the holder's wallet. */
  credentialId: string;
  /** Set once the issuer revoked it; the PDF stays available. */
  revokedAt?: string;
}

/** The accreditation registry deployed by `yarn issuer:init` and the accreditation it granted to the demo issuer. */
export interface AccreditationRecord {
  network: string;
  contractId: string;
  evmAddress: string;
  /** Account that deployed the registry: its accreditation authority. */
  authorityAccountId: string;
  course: string;
  credentialDefinitionId: string;
  accreditedAt: string;
  accreditTransactionId: string;
  withdrawnAt?: string;
  withdrawTransactionId?: string;
}

export class CertificateStore {
  constructor(private readonly directory: string) {}

  private file(name: string): string {
    return path.join(this.directory, name);
  }

  private async read<T>(name: string, fallback: T): Promise<T> {
    if (!existsSync(this.file(name))) return fallback;
    return JSON.parse(await readFile(this.file(name), "utf8")) as T;
  }

  /** Write-then-rename, so a crash never leaves a half-written file. */
  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file(name)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, this.file(name));
  }

  readIssuer(): Promise<IssuerRecord | null> {
    return this.read<IssuerRecord | null>("issuer.json", null);
  }

  writeIssuer(record: IssuerRecord): Promise<void> {
    return this.write("issuer.json", record);
  }

  readAccreditation(): Promise<AccreditationRecord | null> {
    return this.read<AccreditationRecord | null>("accreditation.json", null);
  }

  writeAccreditation(record: AccreditationRecord): Promise<void> {
    return this.write("accreditation.json", record);
  }

  listCertificates(): Promise<CertificateRecord[]> {
    return this.read<CertificateRecord[]>("certificates.json", []);
  }

  async getCertificate(certificateId: string): Promise<CertificateRecord | null> {
    return (await this.listCertificates()).find(record => record.certificateId === certificateId) ?? null;
  }

  async putCertificate(record: CertificateRecord): Promise<void> {
    const records = (await this.listCertificates()).filter(item => item.certificateId !== record.certificateId);
    await this.write("certificates.json", [...records, record]);
  }
}
