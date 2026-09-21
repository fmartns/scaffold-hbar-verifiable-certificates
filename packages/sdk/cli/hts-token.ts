/**
 * `yarn hts:token`: creates a development settlement token (treasury/supply key = operator) and explains what it did.
 *
 * For `HEDERA_HTS_CUSTODY=operator` (development/Testnet) only. In production the `SettlementRouter` (#9) is deployed
 * with its own token, treasury and supply key (ADR §6.7); this command never creates that token.
 *
 * Presentation only. The decisions live in `hedera/hts/token-create.ts`; `runCreateToken` returns lines and an exit code
 * and never prints or reads the terminal, so it is testable. Only `main` prints, asks the question and edits `.env`.
 *
 *   yarn hts:token                   show what will be created and what it may cost, ask [y/N], then create
 *   yarn hts:token --yes             do not ask (needed when there is no terminal, e.g. CI)
 *   yarn hts:token --write           also set HEDERA_HTS_TOKEN_ID (and the model, if pool-transfer) in the root .env
 *   yarn hts:token --json            machine-readable result (requires --yes)
 *   options: --name "<text>"  --symbol "<text>"  --decimals <n>  --model mint-transfer|pool-transfer
 *            --initial-supply <n>  --with-supply-key  --with-admin-key  --allow-mainnet
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { formatEnvironmentReport } from "../hedera/environment-report";
import type { EnvironmentVariables } from "../hedera/environment";
import type { SettlementModel } from "../hedera/hts/settlement";
import { provisionHtsToken } from "../hedera/hts/token-create";
import type {
  ProvisionTokenOptions,
  ProvisionTokenResult,
  ProvisionTokenSuccess,
  TokenCreationPlan,
} from "../hedera/hts/token-create";
import { upsertEnvLine } from "./create-topic";
import { EXIT } from "./setup";

export interface CreateTokenResult {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  lines: string[];
  result: ProvisionTokenResult;
}

export interface CreateTokenOptions extends Omit<ProvisionTokenOptions, "confirm"> {
  /** Shows `lines` (the plan and its cost) and asks the person. Without it and without --yes, nothing is created. */
  confirm?: (lines: string[], plan: TokenCreationPlan) => Promise<boolean>;
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const money = (line: { usd: string; hbar: string | null }, rate: string | null) =>
  line.hbar ? `about $${line.usd} (~${line.hbar} HBAR at $${rate}/HBAR)` : `about $${line.usd}`;

/** What is about to happen and what it may cost: shown before anything is paid for. */
export function formatTokenPlan(plan: TokenCreationPlan): string[] {
  const { cost } = plan;
  const network = `${plan.network[0].toUpperCase()}${plan.network.slice(1)}`;
  const lines = [
    "Create a development settlement token",
    "",
    `  Network       ${plan.network} (chain ${plan.chainId})`,
    `  Operator      ${plan.operatorId}, balance ${plan.balance.hbar} HBAR`,
    "",
    "What will be created",
    `  - One HTS fungible token: "${plan.name}" (${plan.symbol}), ${plan.decimals} decimals, initial supply ${plan.initialSupply}.`,
    `  - Treasury: the operator account (${plan.operatorId}).`,
    plan.withSupplyKey
      ? `  - Supply key: the operator, so it can be minted (needed by the ${plan.model} model).`
      : "  - No supply key: this token can never be minted. Use it only as a pre-funded pool (pool-transfer model).",
    plan.withAdminKey
      ? "  - Admin key: the operator, so the token can be updated or deleted. Omit it in production (ADR-001 §6.7)."
      : "  - No admin key: the token is permanent and cannot be edited or deleted.",
    "",
    "This is a DEVELOPMENT token: in production the SettlementRouter (#9) is deployed with its own token, treasury and",
    "supply key. Use HEDERA_HTS_CUSTODY=operator with this token for local testing only.",
    "",
    "Estimated cost, paid by the operator account",
    `  Create the token      ${money(cost.createToken, cost.usdPerHbar)}`,
  ];
  if (cost.usdPerHbar) lines.push(`  Exchange rate         $${cost.usdPerHbar} per HBAR (Mirror Node)`);
  lines.push(
    cost.free
      ? `  ${network} HBAR has no monetary value. On mainnet these are real charges.`
      : "  This is MAINNET: these are real charges and the token is permanent.",
    "  Estimates come from measured Hedera fees; the exact charge is shown afterwards.",
    "",
  );
  return lines;
}

function formatCost(cost: ProvisionTokenSuccess["cost"]) {
  if (cost.charged)
    return `charged ${cost.charged.hbar} HBAR${cost.charged.usd ? ` (about $${cost.charged.usd})` : ""}`;
  return cost.estimate ? `estimated about $${cost.estimate.createToken.usd}; exact charge not visible yet` : "none";
}

export async function runCreateToken(
  argv: string[],
  env: EnvironmentVariables,
  options: CreateTokenOptions = {},
): Promise<CreateTokenResult> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const model = (flagValue(argv, "--model") as SettlementModel | undefined) ?? options.model;

  let planLines: string[] = [];
  let askedNobody = false;
  const result = await provisionHtsToken(env, {
    ...options,
    name: flagValue(argv, "--name") ?? options.name,
    symbol: flagValue(argv, "--symbol") ?? options.symbol,
    decimals: flagValue(argv, "--decimals") ? Number(flagValue(argv, "--decimals")) : options.decimals,
    model,
    initialSupply: flagValue(argv, "--initial-supply")
      ? BigInt(flagValue(argv, "--initial-supply") as string)
      : options.initialSupply,
    withSupplyKey:
      argv.includes("--with-supply-key") || (argv.includes("--no-supply-key") ? false : options.withSupplyKey),
    withAdminKey: argv.includes("--with-admin-key") || options.withAdminKey,
    allowMainnet: argv.includes("--allow-mainnet") || options.allowMainnet,
    confirm: async plan => {
      planLines = formatTokenPlan(plan);
      if (yes) return true;
      if (!options.confirm) {
        askedNobody = true;
        return false;
      }
      return options.confirm(planLines, plan);
    },
  });

  const exitCode: CreateTokenResult["exitCode"] = result.ok
    ? EXIT.OK
    : !result.ok && result.error.retryable && result.error.code === "NETWORK_UNAVAILABLE"
      ? EXIT.UNVERIFIED
      : EXIT.INVALID;

  if (argv.includes("--json")) return { exitCode, lines: [JSON.stringify(result, null, 2)], result };

  if (!result.ok) {
    const lines = ["Create a development settlement token"];
    if (result.environment) lines.push(...formatEnvironmentReport(result.environment));
    if (result.error.code === "CANCELLED") {
      if (askedNobody) {
        lines.splice(0, lines.length, ...planLines);
        lines.push(
          "  x Not running in an interactive terminal, so nothing was created and nothing was charged.",
          "      Fix: run it in a terminal to be asked, or pass --yes to create the token without asking.",
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

  const lines = yes && planLines.length > 0 ? [...planLines] : ["Create a development settlement token"];
  if (result.status === "existing") {
    lines.push(
      `  ok    ${result.tokenId} is already configured and usable; nothing was created and nothing was charged.`,
    );
  } else {
    lines.push(`  ok    Created token ${result.tokenId} on ${result.network}.`);
    if (result.verified) lines.push("  ok    Mirror Node confirms the treasury and supply key.");
  }
  for (const warning of result.warnings) lines.push(`  warn  ${warning}`);

  lines.push("", "The token");
  lines.push(`  Token ID      ${result.tokenId}`);
  if (result.transactionId) lines.push(`  Transaction   ${result.transactionId}`);
  lines.push(
    `  Treasury      the operator account`,
    `  Supply key    ${result.supplyKey ? "the operator (can mint)" : "none (can never be minted)"}`,
    `  Admin key     ${result.adminKey ? "the operator (can be edited or deleted)" : "none: permanent, cannot be edited or deleted"}`,
  );
  if (result.status === "created") lines.push(`  Cost          ${formatCost(result.cost)}`);
  if (result.hashscanTokenUrl) lines.push(`  HashScan      ${result.hashscanTokenUrl}`);
  lines.push("", ...result.envLines.map(line => `Set in .env: ${line}`));
  lines.push("", "Next", "  yarn hts:settle preflight --to <account> --amount <n>   check a settlement against it");
  return { exitCode, lines, result };
}

/** Asks on the terminal. Only `main` uses it, and only when a person is there to answer. */
async function askOnTerminal(lines: string[], plan: TokenCreationPlan): Promise<boolean> {
  console.log(lines.join("\n"));
  const mainnet = plan.network === "mainnet";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      mainnet ? 'Type "yes" to create the token on MAINNET: ' : "Create the token? [y/N] ",
    );
    const value = answer.trim().toLowerCase();
    return mainnet ? value === "yes" : value === "y" || value === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const envFile = path.resolve(__dirname, "../../../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !argv.includes("--json");
  const { exitCode, lines, result } = await runCreateToken(argv, process.env, {
    confirm: interactive ? askOnTerminal : undefined,
  });

  if (result.ok && result.status === "created" && argv.includes("--write") && !argv.includes("--json")) {
    if (existsSync(envFile)) {
      let content = readFileSync(envFile, "utf8");
      for (const line of result.envLines) {
        const [key, value] = line.split("=");
        content = upsertEnvLine(content, key, value);
      }
      writeFileSync(envFile, content);
      lines.push("", "Updated .env.");
    } else {
      lines.push("", "No .env file to update; add the lines above yourself.");
    }
  }
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error("Creating the token failed unexpectedly. Run `yarn setup` and check HashScan before trying again.");
    process.exitCode = EXIT.INVALID;
  });
}
