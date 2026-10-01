/**
 * `yarn verify:testnet`: validates the whole credential flow on Hedera Testnet and writes the evidence (#18).
 *
 * Presentation only. The decisions live in `hedera/testnet/*`; `runVerifyTestnet` returns lines, the report and an exit
 * code and never prints or reads the terminal, so it is testable. Only `main` prints, asks the question and writes the
 * evidence files.
 *
 *   yarn verify:testnet                 show the plan and its estimated cost, ask, then run and write the evidence
 *   yarn verify:testnet --yes           do not ask (needed when there is no terminal)
 *   yarn verify:testnet --dry-run       preflight and plan only; nothing is paid, nothing is written
 *   options: --runs <1-5> (default 2)  --issuer <namespace> (default scaffold-hbar-verify)  --json
 *
 * Testnet only: mainnet (and local) are refused before anything is read or paid.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { EnvironmentVariables } from "../hedera/environment";
import { formatEnvironmentReport } from "../hedera/environment-report";
import { buildVerificationReport, renderReportMarkdown, reportJson, reportPaths } from "../hedera/testnet/report";
import type { VerificationReport } from "../hedera/testnet/report";
import {
  VERIFY_TESTNET_DEFAULTS,
  balanceCovers,
  isValidIssuerName,
  parseRuns,
  planVerification,
  runVerification,
} from "../hedera/testnet/verification";
import type { PlanResult, ProgressSink, VerificationPlan, VerifyDeps } from "../hedera/testnet/verification";
import { EXIT } from "./setup";

export interface VerifyTestnetResult {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  lines: string[];
  plan?: PlanResult;
  report?: VerificationReport;
}

export interface VerifyTestnetOptions extends VerifyDeps {
  /** Shows the plan and asks the person. Without it and without --yes, nothing is paid. */
  confirm?: (lines: string[]) => Promise<boolean>;
  /** Live progress (the CLI prints it as it happens). */
  progress?: ProgressSink;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const TITLE = "Validate the credential flow on Hedera Testnet";

/** What is about to happen and what it may cost: shown before anything is paid for. */
export function formatPlan(plan: VerificationPlan): string[] {
  const { cost } = plan;
  const lines = [
    TITLE,
    "",
    `  Network       ${plan.network} (chain ${plan.chainId})`,
    `  Operator      ${plan.operatorId}, balance ${plan.balance.hbar} HBAR`,
    `  Registry      ${plan.registry.address} (${plan.registry.source === "manifest" ? "packages/sdk/generated" : "HEDERA_CREDENTIAL_REGISTRY_ADDRESS"})`,
    `  HCS topic     ${plan.topic.id}`,
    `  Issuer        "${plan.issuer.name}", signer ${plan.issuer.signer} (the operator's ECDSA key)`,
    "",
    `What will happen, ${plan.runs} time(s), each with a new throwaway credential`,
    ...(plan.issuer.register
      ? ["  0. Register the issuer namespace once (registerIssuer; the operator holds ADMIN_ROLE)."]
      : []),
    "  1. Issue: sign, dry-run, publish the evidence to HCS and wait for consensus, then send issue().",
    "  2. Audit with the Mirror Node until the evidence is consistent (inside the index budget).",
    "  3. Try to re-issue it (exact replay and same reference): must be refused, nothing published or paid.",
    "  4. Revoke: publish the revocation evidence to HCS first, then send revoke().",
    "  5. Audit again, then try to revoke it again: must be refused.",
    `  The evidence (transaction IDs, HashScan links, timings, audit reports) is written to docs/evidence/testnet/.`,
    "",
    "Estimated cost, paid by the operator account (upper bound)",
    `  HCS messages          ${cost.hcsMessages} × about $${cost.hcsPerMessage.usd}${cost.hcsPerMessage.hbar ? ` (~${cost.hcsPerMessage.hbar} HBAR)` : ""}`,
    ...cost.contractCalls.map(c => `  ${`${c.call}()`.padEnd(21)} ${c.count} × ≤ ${c.gas} gas`),
  ];
  if (cost.gasPriceWeibars) lines.push(`  Gas price             ${cost.gasPriceWeibars} weibars (relay)`);
  lines.push(
    cost.totalHbar
      ? `  Total                 ≤ ${cost.totalHbar} HBAR (about $${cost.totalUsd} at $${cost.usdPerHbar} per HBAR)`
      : "  Total                 unknown (exchange rate or gas price unavailable)",
    "  Testnet HBAR has no monetary value. Estimates only; the exact charges are on HashScan afterwards.",
    "",
  );
  return lines;
}

function problemLines(plan: Extract<PlanResult, { ok: false }>): string[] {
  if (plan.environment) return [TITLE, ...formatEnvironmentReport(plan.environment)];
  return [TITLE, `  x [${plan.problem.code}] ${plan.problem.message}`, `      Fix: ${plan.problem.remediation}`];
}

export async function runVerifyTestnet(
  argv: string[],
  env: EnvironmentVariables,
  options: VerifyTestnetOptions = {},
): Promise<VerifyTestnetResult> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const runs = parseRuns(flagValue(argv, "--runs"));
  const issuerName = flagValue(argv, "--issuer") ?? VERIFY_TESTNET_DEFAULTS.issuerName;

  if (runs === null) {
    return {
      exitCode: EXIT.INVALID,
      lines: [TITLE, `  x --runs must be an integer from 1 to ${VERIFY_TESTNET_DEFAULTS.maxRuns}.`],
    };
  }
  if (!isValidIssuerName(issuerName)) {
    return {
      exitCode: EXIT.INVALID,
      lines: [TITLE, "  x --issuer must be 3-64 lowercase letters, digits or dashes (e.g. scaffold-hbar-verify)."],
    };
  }
  if (json && !yes && !dryRun) {
    return { exitCode: EXIT.INVALID, lines: [TITLE, "  x --json needs --yes (or --dry-run): nobody can be asked."] };
  }

  const plan = await planVerification(env, { ...options, runs, issuerName });
  if (!plan.ok) {
    const exitCode = plan.status === "unverified" ? EXIT.UNVERIFIED : EXIT.INVALID;
    if (json) return { exitCode, lines: [JSON.stringify(plan, null, 2)], plan };
    return { exitCode, lines: problemLines(plan), plan };
  }

  const planLines = formatPlan(plan.plan);
  if (balanceCovers(plan.plan) === false) {
    return {
      exitCode: EXIT.INVALID,
      lines: [
        ...planLines,
        `  x [INSUFFICIENT_BALANCE] The operator balance (${plan.plan.balance.hbar} HBAR) does not cover the estimate.`,
        "      Fix: fund the Testnet account at https://portal.hedera.com/faucet, or pass --runs 1.",
      ],
      plan,
    };
  }
  if (dryRun) {
    if (json) return { exitCode: EXIT.OK, lines: [JSON.stringify({ ok: true, plan: plan.plan }, null, 2)], plan };
    return { exitCode: EXIT.OK, lines: [...planLines, "Dry run: nothing was sent, paid or written."], plan };
  }
  if (!yes) {
    if (!options.confirm) {
      return {
        exitCode: EXIT.INVALID,
        lines: [
          ...planLines,
          "  x Not running in an interactive terminal, so nothing was sent and nothing was charged.",
          "      Fix: run it in a terminal to be asked, or pass --yes to run without asking.",
        ],
        plan,
      };
    }
    if (!(await options.confirm(planLines))) {
      return { exitCode: EXIT.INVALID, lines: [TITLE, "  Cancelled. Nothing was sent and nothing was charged."], plan };
    }
  }

  const result = await runVerification(plan.plan, plan.session, options, options.progress);
  const report = buildVerificationReport(plan.plan, result);
  const exitCode = report.ok ? EXIT.OK : EXIT.INVALID;
  if (json) return { exitCode, lines: [reportJson(report)], plan, report };

  const paths = reportPaths(report);
  const lines = yes ? [...planLines] : [TITLE];
  lines.push(
    report.ok
      ? `  ok    ${result.runs.length} run(s) passed: issued, audited consistent, re-issuance refused, revoked, audited consistent.`
      : "  x     The validation failed; the evidence records where and why.",
  );
  for (const run of result.runs) {
    lines.push(
      `  Run ${run.index}  ${run.ok ? "passed" : `failed${run.failure ? ` at ${run.failure.stage}` : ""}`}  ${run.credentialId ?? ""}`.trimEnd(),
    );
    for (const step of [run.issuance, run.revocation]) {
      if (step?.hcs.hashscanUrl) lines.push(`    HCS       ${step.hcs.hashscanUrl}`);
      if (step?.registry.hashscanUrl) lines.push(`    Registry  ${step.registry.hashscanUrl}`);
    }
  }
  lines.push("", `Evidence: ${paths.markdown} and ${paths.json}`);
  return { exitCode, lines, plan, report };
}

/** Reads the answer to the confirmation: Enter means yes on Testnet (`[Y/n]`). */
export function interpretAnswer(answer: string): boolean {
  const value = answer.trim().toLowerCase();
  return value === "" || value === "y" || value === "yes";
}

async function askOnTerminal(lines: string[]): Promise<boolean> {
  console.log(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return interpretAnswer(await rl.question("Run the validation on Testnet? [Y/n] "));
  } finally {
    rl.close();
  }
}

/** Writes the Markdown and JSON evidence under the repository root. Returns the paths written. */
export function writeEvidence(root: string, report: VerificationReport): string[] {
  const paths = reportPaths(report);
  mkdirSync(path.join(root, path.dirname(paths.markdown)), { recursive: true });
  writeFileSync(path.join(root, paths.markdown), renderReportMarkdown(report));
  writeFileSync(path.join(root, paths.json), reportJson(report));
  return [paths.markdown, paths.json];
}

async function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(__dirname, "../../..");
  const envFile = path.join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set

  const json = argv.includes("--json");
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json;
  const { exitCode, lines, report } = await runVerifyTestnet(argv, process.env, {
    confirm: interactive ? askOnTerminal : undefined,
    progress: json ? undefined : line => console.log(line),
  });
  if (report) writeEvidence(root, report);
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error(
      "The Testnet validation failed unexpectedly. Run `yarn setup` and check HashScan before running again.",
    );
    process.exitCode = EXIT.INVALID;
  });
}
