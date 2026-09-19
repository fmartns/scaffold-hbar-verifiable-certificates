/**
 * `yarn hcs:topic`: creates the HCS evidence topic (submitKey = operator key) and explains what it did.
 *
 * Presentation only. The decisions live in `hedera/hcs/topic-create.ts` and `hedera/hcs/smoke-test.ts`; `runCreateTopic`
 * returns lines and an exit code and never prints or reads the terminal, so it is testable. Only `main` prints, asks the
 * question and edits `.env`.
 *
 *   yarn hcs:topic                  show what will be created and what it may cost, ask, then create
 *   yarn hcs:topic --yes            do not ask (needed when there is no terminal, e.g. CI)
 *   yarn hcs:topic --write          also set HEDERA_HCS_TOPIC_ID in the repository-root .env
 *   yarn hcs:topic --smoke-test     afterwards, publish one message and read it back from Mirror Node
 *   yarn hcs:topic --json           machine-readable result (requires --yes)
 *   options: --with-admin-key  --memo "<text>"  --allow-mainnet
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { EnvironmentVariables } from "../hedera/environment";
import { formatEnvironmentReport } from "../hedera/environment-report";
import type { CostEstimate } from "../hedera/hcs/cost";
import { runPublishSmokeTest } from "../hedera/hcs/smoke-test";
import type { SmokeTestOptions, SmokeTestResult } from "../hedera/hcs/smoke-test";
import { provisionHcsTopic } from "../hedera/hcs/topic-create";
import type { CreationPlan, ProvisionOptions, ProvisionResult } from "../hedera/hcs/topic-create";
import { EXIT } from "./setup";

export interface CreateTopicResult {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  lines: string[];
  result: ProvisionResult;
  smokeTest?: SmokeTestResult;
}

export interface CreateTopicOptions extends Omit<ProvisionOptions, "confirm"> {
  /**
   * Shows `lines` (the plan and its cost) and asks the person. Provide it only when a person can answer; without it and
   * without `--yes` the command refuses to create anything.
   */
  confirm?: (lines: string[], plan: CreationPlan) => Promise<boolean>;
  smokeTest?: Partial<SmokeTestOptions>;
}

/** Sets `KEY=value` in dotenv text: replaces the existing line, or appends one. Touches nothing else. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content}${content === "" || content.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/**
 * Reads the answer to the confirmation. On testnet/local Enter means yes (`[Y/n]`); on mainnet only the word `yes`
 * counts, because that is real money.
 */
export function interpretAnswer(answer: string, mainnet: boolean): boolean {
  const value = answer.trim().toLowerCase();
  return mainnet ? value === "yes" : value === "" || value === "y" || value === "yes";
}

/** What `--write` should do for a result: which line to set, or why there is nothing to write. */
export function planEnvWrite(
  result: ProvisionResult,
  envFileExists: boolean,
): { write: true; key: string; value: string; message: string } | { write: false; message: string | null } {
  if (!result.ok) return { write: false, message: null };
  if (result.status === "existing") {
    return { write: false, message: `Nothing to write: ${result.envLine.split("=")[0]} is already set to this topic.` };
  }
  if (!envFileExists) return { write: false, message: "No .env file to update; add the line above yourself." };
  const [key] = result.envLine.split("=");
  return { write: true, key, value: result.topicId, message: "Updated .env." };
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const money = (line: { usd: string; hbar: string | null }) =>
  line.hbar ? `about $${line.usd} (~${line.hbar} HBAR)` : `about $${line.usd}`;

/** What is about to happen and what it may cost: shown before anything is paid for. */
export function formatPlan(plan: CreationPlan, smokeTest: boolean): string[] {
  const { cost } = plan;
  const network = `${plan.network[0].toUpperCase()}${plan.network.slice(1)}`;
  const lines = [
    "Create the HCS evidence topic",
    "",
    `  Network       ${plan.network} (chain ${plan.chainId})`,
    `  Operator      ${plan.operatorId}, balance ${plan.balance.hbar} HBAR`,
    "",
    "What will be created",
    "  - One HCS topic: the public, append-only log where the oracle's signed settlement attestations are recorded as",
    "    evidence, in order and with a consensus timestamp (ADR-001).",
    "  - Write access: only your operator key (the topic's submitKey), so nobody else can add messages.",
    plan.withAdminKey
      ? "  - Admin key: your operator key, so the topic can be edited or deleted. Omit it in production (ADR-001 §6.3)."
      : "  - No admin key: the topic is permanent and cannot be edited or deleted, as the ADR recommends.",
    `  - Memo: "${plan.memo}"`,
    "",
    "Estimated cost, paid by the operator account",
    `  Create the topic      ${money(cost.createTopic)}`,
    `  Each message later    ${money(cost.publishMessage)}; larger messages cost more`,
  ];
  if (smokeTest) lines.push(`  With --smoke-test     one message is published now: ${money(cost.publishMessage)} more`);
  if (cost.usdPerHbar) lines.push(`  Exchange rate         $${cost.usdPerHbar} per HBAR (Mirror Node)`);
  lines.push(
    cost.free
      ? `  ${network} HBAR has no monetary value. On mainnet these are real charges.`
      : "  This is MAINNET: these are real charges and the topic is permanent.",
    "  Estimates come from measured Hedera fees; the exact charge is shown afterwards.",
    "",
  );
  return lines;
}

function formatCost(cost: { estimate: CostEstimate | null; charged: { hbar: string; usd: string | null } | null }) {
  if (cost.charged) {
    return `charged ${cost.charged.hbar} HBAR${cost.charged.usd ? ` (about $${cost.charged.usd})` : ""}`;
  }
  return cost.estimate ? `estimated ${money(cost.estimate.createTopic)}; exact charge not visible yet` : "none";
}

function formatSmokeTest(smoke: SmokeTestResult): string[] {
  const lines = ["", "Smoke test: publish one message and read it back"];
  if (!smoke.ok && smoke.stage === "publish") {
    lines.push(`  x [${smoke.error.code}] ${smoke.error.message}`, `      Fix: ${smoke.error.remediation}`);
    return lines;
  }
  if (!smoke.ok) {
    lines.push(
      `  ok    Published (sequence ${smoke.published.hcsRef.sequence}) in ${smoke.timings.publishMs} ms.`,
      `  x     ${smoke.message}`,
    );
    if (smoke.published.hashscanUrl) lines.push(`  HashScan: ${smoke.published.hashscanUrl}`);
    return lines;
  }
  const { published } = smoke;
  lines.push(
    `  ok    Published in ${smoke.timings.publishMs} ms: topic sequence ${published.hcsRef.sequence}, transaction ${published.transactionId}.`,
    `  ok    Read it back from Mirror Node in ${smoke.timings.readMs} ms; it decodes to the attestation that was sent (digest and signer match).`,
  );
  if (smoke.charged) {
    lines.push(
      `  ok    Charged ${smoke.charged.hbar} HBAR${smoke.charged.usd ? ` (about $${smoke.charged.usd})` : ""}.`,
    );
  }
  if (published.hashscanUrl) lines.push(`  HashScan: ${published.hashscanUrl}`);
  lines.push(
    "  note  It is a throwaway attestation signed by a random key: no router accepts its source, so it can never settle",
    smoke.routerIsPlaceholder
      ? "        anything. It stays in the topic permanently. No router is configured yet, so a placeholder address was used."
      : "        anything. It stays in the topic permanently.",
  );
  return lines;
}

export async function runCreateTopic(
  argv: string[],
  env: EnvironmentVariables,
  options: CreateTopicOptions = {},
): Promise<CreateTopicResult> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const wantsSmokeTest = argv.includes("--smoke-test");

  let planLines: string[] = [];
  let askedNobody = false;
  const result = await provisionHcsTopic(env, {
    ...options,
    memo: flagValue(argv, "--memo") ?? options.memo,
    withAdminKey: argv.includes("--with-admin-key") || options.withAdminKey,
    allowMainnet: argv.includes("--allow-mainnet") || options.allowMainnet,
    confirm: async plan => {
      planLines = formatPlan(plan, wantsSmokeTest);
      if (yes) return true;
      if (!options.confirm) {
        askedNobody = true;
        return false;
      }
      return options.confirm(planLines, plan); // the prompter shows the plan itself
    },
  });

  let smokeTest: SmokeTestResult | undefined;
  if (wantsSmokeTest && result.ok) {
    smokeTest = await runPublishSmokeTest(env, { ...options.smokeTest, topicId: result.topicId, fetch: options.fetch });
  }

  const exitCode: CreateTopicResult["exitCode"] =
    result.ok && (!smokeTest || smokeTest.ok)
      ? EXIT.OK
      : !result.ok && result.error.retryable && result.error.code === "NETWORK_UNAVAILABLE"
        ? EXIT.UNVERIFIED
        : EXIT.INVALID;

  if (argv.includes("--json")) {
    return {
      exitCode,
      lines: [JSON.stringify({ ...result, ...(smokeTest && { smokeTest }) }, null, 2)],
      result,
      smokeTest,
    };
  }

  if (!result.ok) {
    const lines = ["Create the HCS evidence topic"];
    if (result.environment) lines.push(...formatEnvironmentReport(result.environment));
    if (result.error.code === "CANCELLED") {
      if (askedNobody) {
        lines.splice(0, lines.length, ...planLines);
        lines.push(
          "  x Not running in an interactive terminal, so nothing was created and nothing was charged.",
          "      Fix: run it in a terminal to be asked, or pass --yes to create the topic without asking.",
        );
      } else {
        lines.push("  Cancelled. Nothing was created and nothing was charged.");
      }
      return { exitCode, lines, result };
    }
    lines.push(`  x [${result.error.code}] ${result.error.message}`, `      Fix: ${result.error.remediation}`);
    if (result.error.transactionId) lines.push(`      Transaction: ${result.error.transactionId}`);
    return { exitCode, lines, result };
  }

  // With --yes the plan was not shown by a prompt, so it is part of the output.
  const lines = yes && planLines.length > 0 ? [...planLines] : ["Create the HCS evidence topic"];
  if (result.status === "existing") {
    lines.push(
      `  ok    ${result.topicId} is already configured and usable; nothing was created and nothing was charged.`,
    );
  } else {
    lines.push(`  ok    Created topic ${result.topicId} on ${result.network}.`);
    if (result.verified) lines.push("  ok    Mirror Node confirms the submitKey is the operator key.");
  }
  for (const warning of result.warnings) lines.push(`  warn  ${warning}`);

  lines.push("", "The topic");
  lines.push(`  Topic ID      ${result.topicId}`);
  if (result.transactionId) lines.push(`  Transaction   ${result.transactionId}`);
  lines.push(
    "  Can write     only your operator key (the submitKey)",
    "  Can read      anyone: HCS topics are public",
    `  Admin key     ${result.adminKey ? "your operator key (can be edited or deleted)" : "none: permanent, cannot be edited or deleted"}`,
  );
  if (result.status === "created") lines.push(`  Cost          ${formatCost(result.cost)}`);
  if (result.hashscanTopicUrl) lines.push(`  HashScan      ${result.hashscanTopicUrl}`);
  if (result.status === "created") lines.push("", `Set in .env: ${result.envLine}`);

  if (smokeTest) lines.push(...formatSmokeTest(smokeTest));
  lines.push(
    "",
    "Next",
    "  yarn setup                       check the whole environment",
    ...(smokeTest ? [] : ["  yarn hcs:topic --smoke-test      publish one message and read it back (about $0.0005)"]),
  );
  return { exitCode, lines, result, smokeTest };
}

/** Asks on the terminal. Only `main` uses it, and only when a person is there to answer. */
async function askOnTerminal(lines: string[], plan: CreationPlan): Promise<boolean> {
  console.log(lines.join("\n"));
  const mainnet = plan.network === "mainnet";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      mainnet ? 'Type "yes" to create the topic on MAINNET: ' : "Create the topic? [Y/n] ",
    );
    return interpretAnswer(answer, mainnet);
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const envFile = path.resolve(__dirname, "../../../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !argv.includes("--json");
  const { exitCode, lines, result } = await runCreateTopic(argv, process.env, {
    confirm: interactive ? askOnTerminal : undefined,
  });

  if (argv.includes("--write") && !argv.includes("--json")) {
    const plan = planEnvWrite(result, existsSync(envFile));
    if (plan.write) {
      writeFileSync(envFile, upsertEnvLine(readFileSync(envFile, "utf8"), plan.key, plan.value));
    }
    if (plan.message) lines.push("", plan.message);
  }
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error("Creating the topic failed unexpectedly. Run `yarn setup` and check HashScan before trying again.");
    process.exitCode = EXIT.INVALID;
  });
}
