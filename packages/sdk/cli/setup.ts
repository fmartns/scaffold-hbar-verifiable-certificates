/**
 * `yarn setup`: the entry point of the template's initialization flow.
 *
 * This file is only presentation. The decision "is the environment usable?" lives in `hedera/environment.ts`, which the
 * certificate agents and the CI self-check reuse. Everything here is reachable without printing: `runSetup` returns
 * the lines and the exit code, and only `main` writes to the terminal.
 */
import path from "node:path";
import { CERTIFICATE_ENV, findRepositoryRoot } from "../certificates/config";
import { CertificateStore } from "../certificates/store";
import type { IssuerRecord } from "../certificates/store";
import { validateHederaEnvironment } from "../hedera/environment";
import type { EnvironmentVariables, ValidateEnvironmentOptions } from "../hedera/environment";
import { formatEnvironmentReport } from "../hedera/environment-report";
import { isEntryPoint, loadRootEnv } from "./env";

export const EXIT = {
  OK: 0,
  /** The environment is misconfigured: the developer has something to fix. */
  INVALID: 1,
  /** The network could not be reached, so the environment could not be verified. Retrying may help. */
  UNVERIFIED: 2,
} as const;

export interface SetupResult {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  lines: string[];
}

export async function runSetup(
  argv: string[],
  env: EnvironmentVariables,
  options: ValidateEnvironmentOptions & { issuer?: IssuerRecord | null } = {},
): Promise<SetupResult> {
  const { issuer, ...validateOptions } = options;
  const validation = await validateHederaEnvironment(env, validateOptions);

  if (argv.includes("--json")) {
    const exitCode = validation.ok ? EXIT.OK : validation.status === "unverified" ? EXIT.UNVERIFIED : EXIT.INVALID;
    return { exitCode, lines: [JSON.stringify(validation, null, 2)] };
  }

  const lines = ["Setup: validating the Hedera environment", ...formatEnvironmentReport(validation)];

  // Setup stops here for an invalid environment: nothing below may run without a validated account.
  if (!validation.ok) {
    return { exitCode: validation.status === "unverified" ? EXIT.UNVERIFIED : EXIT.INVALID, lines };
  }

  lines.push("", "Environment validated.");
  const record = issuer === undefined ? await readIssuer(env) : issuer;
  if (record && record.network === validation.network) {
    lines.push(
      `Issuer on ${validation.network}: ${record.issuerDid}`,
      `  credential definition: ${record.credentialDefinitionId}`,
      `  revocation entries topic: ${record.revocationEntriesTopicId}`,
      "Next: yarn dev, then open http://localhost:3000",
    );
  } else {
    lines.push(`No issuer on ${validation.network} yet. Next: yarn issuer:init (publishes the issuer on Hedera).`);
  }
  return { exitCode: EXIT.OK, lines };
}

/** The issuer published by `yarn issuer:init`, read from the local data directory. */
function readIssuer(env: EnvironmentVariables): Promise<IssuerRecord | null> {
  const dataDir = path.resolve(findRepositoryRoot(), env[CERTIFICATE_ENV.DATA_DIR] || ".data");
  return new CertificateStore(dataDir).readIssuer();
}

async function main() {
  const loaded = loadRootEnv();
  const { exitCode, lines } = await runSetup(process.argv.slice(2), process.env);
  if (!loaded && !process.argv.includes("--json")) {
    console.log("No .env file found. Create it with: cp .env.example .env\n");
  }
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (isEntryPoint(import.meta.url)) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error("Setup failed unexpectedly. Run `yarn doctor` and try again; report the problem if it persists.");
    process.exitCode = EXIT.INVALID;
  });
}
