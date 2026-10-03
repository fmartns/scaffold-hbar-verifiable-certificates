/**
 * `yarn issuer:init`: publishes the issuer on Hedera once — its `did:hedera`, the CourseCompletion schema, a revocable
 * credential definition and a revocation registry — then deploys the accreditation registry contract and accredits
 * that credential definition for the prerequisite course. Shows the plan and cost and asks before paying (`--yes` skips the
 * question). Idempotent: an issuer already published on the selected network costs nothing. Refuses mainnet without
 * `--allow-mainnet`.
 */
import { createInterface } from "node:readline/promises";
import { CertificateService, loadCertificatesConfig } from "../certificates";
import type { AccreditationRecord, CertificatesConfig, IssuerRecord } from "../certificates";
import type { EnvironmentVariables } from "../hedera/environment";
import { isEntryPoint, loadRootEnv } from "./env";

export interface IssuerInitDependencies {
  loadConfig?: (env: EnvironmentVariables) => Promise<CertificatesConfig>;
  createService?: (config: CertificatesConfig) => Pick<CertificateService, "store" | "initialize" | "shutdown">;
  confirm?: (question: string) => Promise<boolean>;
  print?: (line: string) => void;
}

/**
 * Measured on Testnet on 2026-10-03 at US$ 0.1012/ℏ: 5 topics and 12 messages ≈ 1.2 ℏ; the contract creation ≈ 10.5 ℏ
 * (Hedera's ContractCreate fee, about US$ 1, dominates); the accreditation call ≈ 0.16 ℏ.
 */
const PLAN = [
  "Publishes on Hedera (HCS), paid by the operator account:",
  "  1. did:hedera of the issuer (a topic holding the DID document)",
  "  2. CourseCompletion schema (HCS-1 file)",
  "  3. Revocable credential definition (HCS-1 file)",
  "  4. Revocation registry definition (HCS-1 file) and its entries topic (the state verifiers rebuild)",
  "  5. AccreditationRegistry contract (Smart Contract Service), accrediting that credential definition for the course",
  "Estimated cost: about 12 HBAR on Testnet (≈ US$ 1.20; the contract creation fee is about US$ 1 of it).",
];

function describe(
  record: IssuerRecord,
  accreditation: AccreditationRecord | null,
  config: CertificatesConfig,
): string[] {
  const topic = (id: string) => `${config.hashscanUrl}/topic/${id}`;
  return [
    `Issuer DID:              ${record.issuerDid}`,
    `Schema:                  ${record.schemaId}`,
    `Credential definition:   ${record.credentialDefinitionId}`,
    `Revocation registry:     ${record.revocationRegistryId}`,
    `Revocation entries:      ${topic(record.revocationEntriesTopicId)}`,
    `DID document topic:      ${topic(record.issuerDid.split("_").pop() ?? "")}`,
    ...(accreditation
      ? [
          `Accreditation registry:  ${config.hashscanUrl}/contract/${accreditation.contractId} (${accreditation.course})`,
        ]
      : []),
  ];
}

async function askOnTerminal(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await terminal.question(`${question} [y/N] `)).trim());
  } finally {
    terminal.close();
  }
}

export async function runIssuerInit(
  argv: string[],
  env: EnvironmentVariables,
  dependencies: IssuerInitDependencies = {},
): Promise<number> {
  const {
    loadConfig = loadCertificatesConfig,
    createService = config => new CertificateService(config),
    confirm = askOnTerminal,
    print = console.log,
  } = dependencies;

  const config = await loadConfig(env);
  if (config.network === "mainnet" && !argv.includes("--allow-mainnet")) {
    print("Refusing to publish on mainnet without --allow-mainnet.");
    return 1;
  }
  const service = createService(config);
  try {
    const [existing, accredited] = await Promise.all([service.store.readIssuer(), service.store.readAccreditation()]);
    if (existing?.network === config.network && accredited?.network === config.network) {
      print(`The issuer is already published on ${config.network} (nothing to pay):`);
      describe(existing, accredited, config).forEach(line => print(line));
      return 0;
    }

    PLAN.forEach(line => print(line));
    if (!argv.includes("--yes") && !(await confirm(`Publish the issuer on ${config.network}?`))) {
      print("Nothing was published. Run again and confirm, or pass --yes.");
      return 1;
    }
    print("Publishing… (about a minute: every step waits for consensus and the Mirror Node)");
    const { issuer, accreditation } = await service.initialize();
    print("Issuer published:");
    describe(issuer, accreditation, config).forEach(line => print(line));
    print("Next: yarn dev, then open http://localhost:3000");
    return 0;
  } finally {
    await service.shutdown();
  }
}

if (isEntryPoint(import.meta.url)) {
  loadRootEnv();
  runIssuerInit(process.argv.slice(2), process.env)
    .then(code => (process.exitCode = code))
    .catch(error => {
      // CertificateError messages carry no secret; anything else is reported without its text.
      const safe = error?.name === "CertificateError" ? error.message : "unexpected failure (run `yarn setup`).";
      console.error(`issuer:init failed: ${safe}`);
      process.exitCode = 1;
    });
}
