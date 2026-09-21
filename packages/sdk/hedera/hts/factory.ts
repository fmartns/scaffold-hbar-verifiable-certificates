/**
 * Builds the HTS adapter from the environment, and the startup preflight that composes the environment validator of #5
 * with the token/custody checks. Only this module reads the operator key, and only to create the Hedera client.
 */
import { ENV as HEDERA_ENV, inspectPrivateKey, validateHederaEnvironment } from "../environment";
import type {
  EnvironmentVariables,
  KeyInspector,
  PublicKeyCandidate,
  ValidateEnvironmentOptions,
} from "../environment";
import { createOperatorClient } from "../hcs/hiero-transport";
import { createHtsSettlementAdapter } from "./adapter";
import type { HtsAdapterOptions, HtsSettlementAdapter } from "./adapter";
import { loadHtsAdapterConfig } from "./config";
import { HtsError, classifyHtsError } from "./errors";
import type { HtsFailure } from "./errors";
import { createHieroHtsExecutor } from "./executor";
import type { HieroHtsSdkLike, HtsExecutor } from "./executor";
import { createRouterStatusReader } from "./router-status";
import type { HtsPreflightResult } from "./preflight";

export interface HtsAdapterFromEnvOptions extends Pick<
  HtsAdapterOptions,
  "ledger" | "statusReader" | "timeoutMs" | "lookbackSeconds" | "now"
> {
  fetch?: typeof fetch;
  /**
   * Create an executor. Default: true for operator custody (dev/test), false for router custody, where the router executes
   * on-chain. Set true under router custody only to `associate` an account whose key this process holds.
   */
  withExecutor?: boolean;
  /** Private keys of other accounts this process may sign an association for. */
  accountKeys?: Record<string, unknown>;
  /** Overrides the executor (tests). When set, no Hedera client is created. */
  executor?: HtsExecutor;
  /** Overrides how the operator private key is inspected (tests). Defaults to the Hedera SDK. */
  inspectKey?: KeyInspector;
}

export interface HtsAdapterHandle {
  adapter: HtsSettlementAdapter;
  /** Releases the network client. Safe to call more than once. */
  close(): void;
}

export async function createHtsAdapterFromEnv(
  env: EnvironmentVariables,
  options: HtsAdapterFromEnvOptions = {},
): Promise<HtsAdapterHandle> {
  const config = loadHtsAdapterConfig(env); // throws HtsError CONFIG_INVALID
  const wantsExecutor = options.withExecutor ?? config.custody === "operator";

  let executor = options.executor;
  let close = () => {};
  let operatorKeys: PublicKeyCandidate[] | undefined;
  if (wantsExecutor && !executor) {
    try {
      const operator = await createOperatorClient(env, config.network, options.fetch);
      close = operator.close;
      executor = createHieroHtsExecutor({
        client: operator.client,
        operatorId: env[HEDERA_ENV.OPERATOR_ID]?.trim() as string,
        accountKeys: options.accountKeys,
        sdk: operator.sdk as unknown as HieroHtsSdkLike,
      });
    } catch (error) {
      // createOperatorClient reports configuration problems as HcsPublishError-shaped errors.
      const failure = (error as { failure?: { message?: string; remediation?: string } } | null)?.failure;
      throw new HtsError({
        code: "CONFIG_INVALID",
        outcome: "not_sent",
        operation: "preflight",
        message: failure?.message ?? "The operator account could not be set up.",
        remediation: failure?.remediation ?? "Run `yarn setup` to diagnose.",
        retryable: false,
      });
    }
  }
  if (config.custody === "operator") {
    operatorKeys = (await (options.inspectKey ?? inspectPrivateKey)(env[HEDERA_ENV.OPERATOR_KEY] ?? "")) ?? undefined;
  }

  const statusReader =
    options.statusReader ??
    (config.routerAddress
      ? createRouterStatusReader({ network: config.network, routerAddress: config.routerAddress, fetch: options.fetch })
      : undefined);

  return {
    adapter: createHtsSettlementAdapter({
      config,
      executor,
      operatorKeys,
      statusReader,
      fetch: options.fetch,
      ledger: options.ledger,
      timeoutMs: options.timeoutMs,
      lookbackSeconds: options.lookbackSeconds,
      now: options.now,
    }),
    close,
  };
}

export type HtsSetupPreflight = { ok: true; setup: HtsPreflightResult } | { ok: false; error: HtsFailure };

/**
 * Everything to verify before the first settlement: the Hedera environment (#5: network, account, key, balance), the HTS
 * configuration, and the token and custody setup on Mirror Node. Returns a normalized failure instead of throwing.
 */
export async function preflightHtsAdapter(
  env: EnvironmentVariables,
  options: Pick<ValidateEnvironmentOptions, "fetch" | "timeoutMs" | "now" | "inspectKey"> = {},
): Promise<HtsSetupPreflight> {
  let config;
  try {
    config = loadHtsAdapterConfig(env);
  } catch (error) {
    return { ok: false, error: classifyHtsError(error, { operation: "preflight" }) };
  }
  const environment = await validateHederaEnvironment(env, options);
  if (!environment.ok) {
    const first = environment.issues[0];
    return {
      ok: false,
      error: {
        code: environment.status === "unverified" ? "NETWORK_UNAVAILABLE" : "CONFIG_INVALID",
        outcome: "not_sent",
        operation: "preflight",
        message: `The Hedera environment is not valid: ${environment.issues.map(i => `[${i.code}] ${i.message}`).join(" ")}`,
        remediation: first ? `${first.remediation} Run \`yarn setup\` for the full report.` : "Run `yarn setup`.",
        retryable: environment.status === "unverified",
      },
    };
  }
  // Operator custody needs the operator's public keys to check supply-key ownership.
  const inspect = options.inspectKey ?? inspectPrivateKey;
  const operatorKeys =
    config.custody === "operator" ? ((await inspect(env[HEDERA_ENV.OPERATOR_KEY] ?? "")) ?? []) : undefined;
  const setup = await createHtsSettlementAdapter({ config, operatorKeys, fetch: options.fetch }).checkSetup();
  return setup.ok ? { ok: true, setup } : { ok: false, error: setup.failure as HtsFailure };
}
