/**
 * `yarn hts:settle`: runs a real settlement (associate / transfer) through the HTS adapter, or just checks one.
 *
 * This is a manual testing tool, not part of the production flow: in production the `SettlementRouter` (#9) mints and
 * transfers on-chain, and only `preflight`/`associate` apply there. `transfer` only executes anything when
 * `HEDERA_HTS_CUSTODY=operator` (development/Testnet), which the adapter already refuses on mainnet.
 *
 * Presentation only: the decisions live in `hedera/hts/*`; `runHtsSettle` returns lines and an exit code and never prints
 * or reads the terminal, so it is testable. Only `main` prints, asks the question and resolves a real private key.
 *
 *   yarn hts:settle preflight --to 0.0.x --amount 100 [--token 0.0.y] [--label mine]
 *   yarn hts:settle associate --to 0.0.x [--token 0.0.y] [--account-key <hex>] [--yes]
 *   yarn hts:settle transfer  --to 0.0.x --amount 100 [--token 0.0.y] [--label mine] [--yes] [--allow-mainnet]
 *   options everywhere: --json
 *   identity for transfer/preflight: --label <text> (deterministic; reuse it to test idempotency, vary it for a new
 *     settlement), or the exact --event-key/--settlement-id/--content-hash (all three, 32-byte hex). Neither given
 *     generates a fresh one, printed so it can be reused on purpose.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { EnvironmentVariables, KeyInspector } from "../hedera/environment";
import type { HtsCostEstimate } from "../hedera/hts/cost";
import { buildHtsCostEstimate, fetchChargedFee } from "../hedera/hts/cost";
import { fetchUsdPerHbar } from "../hedera/cost";
import { loadHtsAdapterConfig } from "../hedera/hts/config";
import type { HtsAdapterConfig } from "../hedera/hts/config";
import { createHtsAdapterFromEnv, preflightHtsAdapter } from "../hedera/hts/factory";
import type { HtsAdapterFromEnvOptions, HtsAdapterHandle } from "../hedera/hts/factory";
import { resolveKeyForAccount } from "../hedera/hcs/hiero-transport";
import { manualSettlementIdentifiers } from "../hedera/hts/manual-settlement";
import type { AssociateResult, SettleResult } from "../hedera/hts/types";
import type { PreflightOutcome } from "../hedera/hts/adapter";
import { HtsError } from "../hedera/hts/errors";
import { EXIT } from "./setup";

export interface HtsSettleResult {
  exitCode: (typeof EXIT)[keyof typeof EXIT];
  lines: string[];
  preflight?: PreflightOutcome;
  associate?: AssociateResult;
  settle?: SettleResult;
}

export interface HtsSettleOptions extends Pick<HtsAdapterFromEnvOptions, "fetch" | "ledger" | "statusReader" | "now"> {
  /** Shows `lines` (the plan and its cost) and asks the person. Without it and without --yes, nothing is sent. */
  confirm?: (lines: string[]) => Promise<boolean>;
  /** Overrides how the operator private key is inspected in the system-level preflight (tests). */
  inspectKey?: KeyInspector;
  /** Resolves --account-key against the beneficiary account. Defaults to the real Hedera SDK. Injectable for tests. */
  resolveAccountKey?: (
    rawKey: string,
    accountId: string,
    config: HtsAdapterConfig,
    fetchImpl: typeof fetch,
  ) => Promise<unknown>;
  /** Overrides adapter creation (tests). */
  createAdapter?: typeof createHtsAdapterFromEnv;
}

/** `PreflightOutcome` can carry `bigint` (e.g. a token\'s supply); the other results here are already JSON-safe strings. */
const toJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function defaultResolveAccountKey(
  rawKey: string,
  accountId: string,
  config: HtsAdapterConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const sdk = await import("@hiero-ledger/sdk");
  return resolveKeyForAccount(rawKey, accountId, config.network, sdk as never, fetchImpl, "--account-key");
}

const money = (line: { usd: string; hbar: string | null }) =>
  line.hbar ? `about $${line.usd} (~${line.hbar} HBAR)` : `about $${line.usd}`;

function formatCostPlan(
  cost: HtsCostEstimate,
  network: string,
  operations: ("associate" | "mint" | "transfer")[],
): string[] {
  const lines = ["", "Estimated cost, paid by the operator account"];
  for (const op of operations) lines.push(`  ${op.padEnd(10)}${money(cost[op])}`);
  lines.push(
    cost.usdPerHbar
      ? `  Exchange rate  $${cost.usdPerHbar} per HBAR (Mirror Node)`
      : "  Exchange rate unknown: showing USD only.",
  );
  lines.push(
    cost.free
      ? `  ${network[0].toUpperCase()}${network.slice(1)} HBAR has no monetary value. On mainnet these are real charges.`
      : "  This is MAINNET: these are real charges.",
  );
  return lines;
}

async function ask(confirm: HtsSettleOptions["confirm"], yes: boolean, lines: string[]): Promise<boolean> {
  if (yes) return true;
  if (!confirm) return false;
  return confirm(lines);
}

function cancellationLine(yes: boolean, hasConfirm: boolean): string {
  if (yes) return "";
  return hasConfirm
    ? "  Cancelled. Nothing was sent and nothing was charged."
    : "  Not running in an interactive terminal, so nothing was sent and nothing was charged.\n      Fix: run it in a terminal to be asked, or pass --yes to send without asking.";
}

function formatFailure(prefix: string, failure: import("../hedera/hts/errors").HtsFailure): string[] {
  const lines = [`  x [${failure.code}] ${failure.message}`, `      Fix: ${failure.remediation}`];
  if (failure.transactionId) lines.push(`      Transaction: ${failure.transactionId}`);
  if (failure.appliedTransactions?.length)
    lines.push(`      Already applied: ${failure.appliedTransactions.join(", ")}`);
  return [prefix, ...lines];
}

function formatOperation(op: { operation: string; transactionId: string; hashscanUrl: string | null }): string {
  return `  ok    ${op.operation.padEnd(9)}${op.transactionId}${op.hashscanUrl ? `  ${op.hashscanUrl}` : ""}`;
}

/**
 * Refuses mainnet before any request, for any operation that sends a real transaction (association, transfer): both cost
 * real HBAR regardless of custody. Checked directly against the raw variable, so it never depends on the rest of the
 * configuration being valid.
 */
function mainnetGuard(env: EnvironmentVariables, argv: string[], lines: string[]): HtsSettleResult | null {
  if ((env.HEDERA_NETWORK ?? "").trim() !== "mainnet" || argv.includes("--allow-mainnet")) return null;
  return {
    exitCode: EXIT.INVALID,
    lines: [
      ...lines,
      "  x [CONFIG_INVALID] This would run on mainnet: real money.",
      "      Fix: Run again with --allow-mainnet if you are sure.",
    ],
  };
}

async function runPreflightSubcommand(
  argv: string[],
  env: EnvironmentVariables,
  options: HtsSettleOptions,
): Promise<HtsSettleResult> {
  const to = flagValue(argv, "--to");
  const amount = flagValue(argv, "--amount");
  if (!to || !amount) {
    return {
      exitCode: EXIT.INVALID,
      lines: ["Usage: yarn hts:settle preflight --to <account> --amount <n> [--token 0.0.x] [--label <text>]"],
    };
  }

  const system = await preflightHtsAdapter(env, { fetch: options.fetch, inspectKey: options.inspectKey });
  const lines = ["HTS settlement preflight"];
  if (!system.ok)
    return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Environment/setup", system.error)] };

  let handle: HtsAdapterHandle;
  try {
    handle = await (options.createAdapter ?? createHtsAdapterFromEnv)(env, {
      fetch: options.fetch,
      withExecutor: false,
    });
  } catch (error) {
    return {
      exitCode: EXIT.INVALID,
      lines: [...lines, ...formatFailure("Configuration", (error as HtsError).failure)],
    };
  }
  try {
    const tokenId = flagValue(argv, "--token") ?? handle.adapter.config.tokenId;
    const ids = manualSettlementIdentifiers({
      label: flagValue(argv, "--label"),
      tokenId,
      beneficiary: to,
      amount: BigInt(amount),
      now: options.now ? () => options.now!().getTime() : undefined,
    });
    const eventKey = flagValue(argv, "--event-key") ?? ids.eventKey;
    const settlementId = flagValue(argv, "--settlement-id") ?? ids.settlementId;
    const contentHash = flagValue(argv, "--content-hash") ?? ids.contentHash;
    const outcome = await handle.adapter.preflight({
      eventKey,
      settlementId,
      contentHash,
      tokenId,
      beneficiary: to,
      amount,
    });

    if (argv.includes("--json"))
      return {
        exitCode: outcome.ok ? EXIT.OK : EXIT.INVALID,
        lines: [toJson(outcome)],
        preflight: outcome,
      };

    lines.push(`  Identity label: ${ids.label}`, `  eventKey:       ${eventKey}`);
    if (!outcome.valid)
      return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Invalid input", outcome.failure)] };
    for (const check of outcome.checks)
      lines.push(
        `  ${check.ok ? (check.severity === "warning" ? "warn " : "ok   ") : "x    "} ${check.id}: ${check.message}`,
      );
    if (!outcome.ok && outcome.failure) lines.push(...formatFailure("Would fail", outcome.failure));
    else lines.push("", "This settlement would go through.");
    return { exitCode: outcome.ok ? EXIT.OK : EXIT.INVALID, lines, preflight: outcome };
  } finally {
    handle.close();
  }
}

async function runAssociateSubcommand(
  argv: string[],
  env: EnvironmentVariables,
  options: HtsSettleOptions,
): Promise<HtsSettleResult> {
  const to = flagValue(argv, "--to");
  if (!to)
    return {
      exitCode: EXIT.INVALID,
      lines: ["Usage: yarn hts:settle associate --to <account> [--token 0.0.x] [--account-key <hex>] [--yes]"],
    };

  const lines = ["HTS token association"];
  const refused = mainnetGuard(env, argv, lines);
  if (refused) return refused;

  const system = await preflightHtsAdapter(env, { fetch: options.fetch, inspectKey: options.inspectKey });
  if (!system.ok)
    return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Environment/setup", system.error)] };

  let config: HtsAdapterConfig;
  try {
    config = loadHtsAdapterConfig(env);
  } catch (error) {
    return {
      exitCode: EXIT.INVALID,
      lines: [...lines, ...formatFailure("Configuration", (error as HtsError).failure)],
    };
  }
  const rawKey = flagValue(argv, "--account-key");
  let accountKeys: Record<string, unknown> | undefined;
  if (rawKey) {
    try {
      accountKeys = {
        [to]: await (options.resolveAccountKey ?? defaultResolveAccountKey)(
          rawKey,
          to,
          config,
          options.fetch ?? globalThis.fetch,
        ),
      };
    } catch (error) {
      return {
        exitCode: EXIT.INVALID,
        lines: [...lines, ...formatFailure("--account-key", (error as HtsError).failure)],
      };
    }
  }

  const usdPerHbar = await fetchUsdPerHbar(config.network, options.fetch);
  const cost = buildHtsCostEstimate(config.network, usdPerHbar);
  const tokenId = flagValue(argv, "--token") ?? config.tokenId;
  const plan = [
    `  Account  ${to}`,
    `  Token    ${tokenId}`,
    `  Network  ${config.network.name}`,
    ...formatCostPlan(cost, config.network.name, ["associate"]),
    "  If the account is already associated, nothing will be sent and nothing will be charged.",
  ];
  const yes = argv.includes("--yes") || argv.includes("-y");
  if (!(await ask(options.confirm, yes, [...lines, ...plan]))) {
    return { exitCode: EXIT.INVALID, lines: [...lines, ...plan, "", cancellationLine(yes, Boolean(options.confirm))] };
  }

  let handle: HtsAdapterHandle;
  try {
    handle = await (options.createAdapter ?? createHtsAdapterFromEnv)(env, {
      fetch: options.fetch,
      withExecutor: true,
      accountKeys,
    });
  } catch (error) {
    return {
      exitCode: EXIT.INVALID,
      lines: [...lines, ...formatFailure("Configuration", (error as HtsError).failure)],
    };
  }
  try {
    const result = await handle.adapter.associate({ accountId: to, tokenId });
    if (argv.includes("--json"))
      return {
        exitCode: result.ok ? EXIT.OK : EXIT.INVALID,
        lines: [JSON.stringify(result, null, 2)],
        associate: result,
      };
    if (!result.ok) return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Failed", result.failure)] };
    if (result.status === "already_associated")
      return {
        exitCode: EXIT.OK,
        lines: [...lines, "  ok    Already associated; nothing was sent and nothing was charged."],
      };
    const done = ["  ok    Associated.", ...(result.operation ? [formatOperation(result.operation)] : [])];
    if (result.operation) {
      const charged = await fetchChargedFee(
        config.network,
        result.operation.mirrorTransactionId,
        usdPerHbar,
        options.fetch,
      );
      if (charged) done.push(`  ok    Charged ${charged.hbar} HBAR${charged.usd ? ` (about $${charged.usd})` : ""}.`);
    }
    return { exitCode: EXIT.OK, lines: [...lines, ...done], associate: result };
  } finally {
    handle.close();
  }
}

async function runTransferSubcommand(
  argv: string[],
  env: EnvironmentVariables,
  options: HtsSettleOptions,
): Promise<HtsSettleResult> {
  const to = flagValue(argv, "--to");
  const amount = flagValue(argv, "--amount");
  if (!to || !amount) {
    return {
      exitCode: EXIT.INVALID,
      lines: [
        "Usage: yarn hts:settle transfer --to <account> --amount <n> [--token 0.0.x] [--label <text>] [--yes] [--allow-mainnet]",
      ],
    };
  }

  const lines = ["HTS settlement transfer"];
  const refused = mainnetGuard(env, argv, lines);
  if (refused) return refused;

  const system = await preflightHtsAdapter(env, { fetch: options.fetch, inspectKey: options.inspectKey });
  if (!system.ok)
    return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Environment/setup", system.error)] };

  let config: HtsAdapterConfig;
  try {
    config = loadHtsAdapterConfig(env);
  } catch (error) {
    return {
      exitCode: EXIT.INVALID,
      lines: [...lines, ...formatFailure("Configuration", (error as HtsError).failure)],
    };
  }
  let handle: HtsAdapterHandle;
  try {
    handle = await (options.createAdapter ?? createHtsAdapterFromEnv)(env, {
      fetch: options.fetch,
      ledger: options.ledger,
      statusReader: options.statusReader,
    });
  } catch (error) {
    return {
      exitCode: EXIT.INVALID,
      lines: [...lines, ...formatFailure("Configuration", (error as HtsError).failure)],
    };
  }
  try {
    const tokenId = flagValue(argv, "--token") ?? config.tokenId;
    const ids = manualSettlementIdentifiers({
      label: flagValue(argv, "--label"),
      tokenId,
      beneficiary: to,
      amount: BigInt(amount),
      now: options.now ? () => options.now!().getTime() : undefined,
    });
    const input = {
      eventKey: flagValue(argv, "--event-key") ?? ids.eventKey,
      settlementId: flagValue(argv, "--settlement-id") ?? ids.settlementId,
      contentHash: flagValue(argv, "--content-hash") ?? ids.contentHash,
      tokenId,
      beneficiary: to,
      amount,
    };

    const check = await handle.adapter.preflight(input);
    if (!check.ok) {
      return {
        exitCode: EXIT.INVALID,
        lines: [
          ...lines,
          `  Identity label: ${ids.label}`,
          ...formatFailure("Would fail", check.failure as import("../hedera/hts/errors").HtsFailure),
        ],
      };
    }

    const usdPerHbar = await fetchUsdPerHbar(config.network, options.fetch);
    const cost = buildHtsCostEstimate(config.network, usdPerHbar);
    const operations = config.model === "mint-transfer" ? (["mint", "transfer"] as const) : (["transfer"] as const);
    const plan = [
      `  Network       ${config.network.name}`,
      `  Token         ${tokenId}`,
      `  Model         ${config.model}`,
      `  To            ${to}`,
      `  Amount        ${amount}`,
      `  Identity      ${ids.label} (eventKey ${input.eventKey})`,
      ...formatCostPlan(cost, config.network.name, [...operations]),
      "  If this settlement was already done, nothing will be sent and nothing will be charged.",
    ];
    const yes = argv.includes("--yes") || argv.includes("-y");
    if (!(await ask(options.confirm, yes, [...lines, ...plan]))) {
      return {
        exitCode: EXIT.INVALID,
        lines: [...lines, ...plan, "", cancellationLine(yes, Boolean(options.confirm))],
      };
    }

    const result = await handle.adapter.settle(input);
    if (argv.includes("--json"))
      return { exitCode: result.ok ? EXIT.OK : EXIT.INVALID, lines: [JSON.stringify(result, null, 2)], settle: result };
    if (!result.ok) return { exitCode: EXIT.INVALID, lines: [...lines, ...formatFailure("Failed", result.failure)] };
    if (result.replay) {
      return {
        exitCode: EXIT.OK,
        lines: [
          ...lines,
          `  ok    Already settled (source: ${result.source}); nothing was sent and nothing was charged.`,
        ],
        settle: result,
      };
    }
    const done = ["  ok    Settled.", ...result.operations.map(formatOperation)];
    const last = result.operations[result.operations.length - 1];
    if (last) {
      const charged = await fetchChargedFee(config.network, last.mirrorTransactionId, usdPerHbar, options.fetch);
      if (charged)
        done.push(
          `  ok    Charged ${charged.hbar} HBAR${charged.usd ? ` (about $${charged.usd})` : ""} for the last operation.`,
        );
    }
    return { exitCode: EXIT.OK, lines: [...lines, ...done], settle: result };
  } finally {
    handle.close();
  }
}

export async function runHtsSettle(
  argv: string[],
  env: EnvironmentVariables,
  options: HtsSettleOptions = {},
): Promise<HtsSettleResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "preflight":
      return runPreflightSubcommand(rest, env, options);
    case "associate":
      return runAssociateSubcommand(rest, env, options);
    case "transfer":
      return runTransferSubcommand(rest, env, options);
    default:
      return {
        exitCode: EXIT.INVALID,
        lines: [
          "Usage: yarn hts:settle <preflight|associate|transfer> [options]",
          "",
          "  preflight --to <account> --amount <n>   check a settlement, send nothing",
          "  associate --to <account>                associate an account with the token",
          "  transfer  --to <account> --amount <n>   mint/transfer a real settlement (operator custody only)",
        ],
      };
  }
}

async function askOnTerminal(lines: string[]): Promise<boolean> {
  console.log(lines.join("\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Proceed? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const envFile = path.resolve(__dirname, "../../../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !argv.includes("--json");
  const { exitCode, lines } = await runHtsSettle(argv, process.env, {
    confirm: interactive ? askOnTerminal : undefined,
  });
  console.log(lines.join("\n"));
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch(() => {
    // Deliberately no error text: an unexpected failure must not print values from the environment.
    console.error("hts:settle failed unexpectedly. Run `yarn setup` and check HashScan before trying again.");
    process.exitCode = EXIT.INVALID;
  });
}
