/**
 * `yarn setup`: the entry point of the template's initialization flow.
 *
 * This file is only presentation. The decision "is the environment usable?" lives in `hedera/environment.ts`, which the
 * dashboard (#11) and the CI self-check (#14) reuse. Everything here is reachable without printing: `runSetup` returns
 * the lines and the exit code, and only `main` writes to the terminal.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { describeDeployments } from "../hedera/contracts";
import type { GeneratedDeployments } from "../hedera/contracts";
import { validateHederaEnvironment } from "../hedera/environment";
import type { EnvironmentVariables, ValidateEnvironmentOptions } from "../hedera/environment";
import { formatEnvironmentReport } from "../hedera/environment-report";

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
  options: ValidateEnvironmentOptions & { manifest?: GeneratedDeployments } = {},
): Promise<SetupResult> {
  const { manifest, ...validateOptions } = options;
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

  // Steps that depend on Hedera (deployment, HCS topic, HTS token) are added by later tasks and run from here.
  lines.push("", "Environment validated. Steps that depend on Hedera run after this check.");
  lines.push(
    "",
    `Contracts on ${validation.network} (packages/sdk/generated, written by \`yarn deploy\`):`,
    ...describeDeployments(validation.network, manifest).map(line => `  ${line}`),
  );
  return { exitCode: EXIT.OK, lines };
}

/** Loads the repository-root .env without overriding variables that are already set. Returns whether it existed. */
function loadRootEnv(file: string): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

async function main() {
  const envFile = path.resolve(__dirname, "../../../.env");
  const loaded = loadRootEnv(envFile);
  const { exitCode, lines } = await runSetup(process.argv.slice(2), process.env);
  if (!loaded && !process.argv.includes("--json")) {
    console.log("No .env file found. Create it with: cp .env.example .env\n");
  }
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error("Setup failed unexpectedly. Run `yarn doctor` and try again; report the problem if it persists.");
    process.exitCode = EXIT.INVALID;
  });
}
