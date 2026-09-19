/**
 * Provisioning of the HCS evidence topic (`yarn hcs:topic`).
 *
 * Creates a topic whose `submitKey` is the operator key, as ADR-001 §6.3 requires, after validating the environment (#5).
 * It is deliberately conservative because a topic is permanent and costs HBAR:
 *  - it never creates a second topic when `HEDERA_HCS_TOPIC_ID` already points to a usable one;
 *  - it refuses mainnet unless explicitly allowed;
 *  - it never retries: an `unknown` outcome tells the caller to look at the account before running it again.
 * No `console`, no prompts, no file access: `cli/create-topic.ts` is the presentation layer.
 */
import { validateHederaEnvironment, inspectPrivateKey, ENV as HEDERA_ENV } from "../environment";
import type {
  EnvironmentVariables,
  HbarAmount,
  InvalidEnvironment,
  KeyInspector,
  ValidateEnvironmentOptions,
} from "../environment";
import { getSelectedNetwork, isNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { HCS_ENV, isValidTopicId } from "./config";
import { HcsTimeoutError, classifyPublishError } from "./errors";
import type { HcsPublishFailure } from "./errors";
import { createOperatorClient } from "./hiero-transport";
import type { HieroSdkLike } from "./hiero-transport";
import { buildCostEstimate, fetchChargedFee, fetchUsdPerHbar } from "./cost";
import type { ChargedFee, CostEstimate } from "./cost";
import { hashscanTopicUrl, toMirrorTransactionId } from "./publisher";
import { verifyHcsTopic } from "./topic-check";

export const DEFAULT_TOPIC_MEMO = "verifiable-settlement evidence";
const MAX_MEMO_BYTES = 100; // Hedera's limit for a topic memo

// ---------------------------------------------------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------------------------------------------------

export interface CreateTopicRequest {
  memo: string;
  /** Also set the operator key as `adminKey` (lets the topic be updated or deleted; ADR says omit in production). */
  withAdminKey: boolean;
  timeoutMs: number;
  /** Called as soon as the transaction id exists, before sending, so a timeout can still report it. */
  onTransactionId(transactionId: string): void;
}

/** Creates one topic with `submitKey` = the operator key. Must not retry. */
export interface TopicCreator {
  create(request: CreateTopicRequest): Promise<{ topicId: string; transactionId: string }>;
}

// Minimal structural view of the SDK, so the adapter is testable with fakes.
export interface TopicCreateTransactionLike {
  setSubmitKey(key: unknown): this;
  setAdminKey(key: unknown): this;
  setTopicMemo(memo: string): this;
  setRegenerateTransactionId(regenerate: boolean): this;
  setMaxAttempts(attempts: number): this;
  setGrpcDeadline(milliseconds: number): this;
  freezeWith(client: unknown): this;
  readonly transactionId: { toString(): string } | null;
  execute(client: unknown): Promise<{
    transactionId: { toString(): string };
    getReceipt(client: unknown): Promise<{ topicId: { toString(): string } | null }>;
  }>;
}

export function createHieroTopicCreator(options: {
  client: unknown;
  /** The operator private key object; only its public key is used. */
  key: { publicKey: unknown };
  sdk: HieroSdkLike & { TopicCreateTransaction: new () => TopicCreateTransactionLike };
}): TopicCreator {
  return {
    async create(request) {
      let transaction = new options.sdk.TopicCreateTransaction()
        .setSubmitKey(options.key.publicKey)
        .setTopicMemo(request.memo)
        .setRegenerateTransactionId(false)
        .setMaxAttempts(3)
        .setGrpcDeadline(Math.max(1_000, Math.floor(request.timeoutMs / 2)));
      if (request.withAdminKey) transaction = transaction.setAdminKey(options.key.publicKey);
      transaction.freezeWith(options.client);
      if (transaction.transactionId) request.onTransactionId(transaction.transactionId.toString());

      const response = await transaction.execute(options.client);
      request.onTransactionId(response.transactionId.toString());
      const receipt = await response.getReceipt(options.client);
      const topicId = receipt.topicId?.toString();
      if (!topicId) throw Object.assign(new Error("the receipt has no topic id"), { name: "MissingTopicId" });
      return { topicId, transactionId: response.transactionId.toString() };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------------------------------------------------

export interface ProvisionOptions extends Pick<ValidateEnvironmentOptions, "fetch" | "timeoutMs" | "now"> {
  /** Overrides the creator (tests). When set, no Hedera client is created. */
  creator?: TopicCreator;
  inspectKey?: KeyInspector;
  memo?: string;
  withAdminKey?: boolean;
  /** Creating a topic on mainnet spends real HBAR and is refused unless this is true. */
  allowMainnet?: boolean;
  /** Deadline of the creation transaction. Default 30 000 ms. */
  createTimeoutMs?: number;
  /** How many times to look for the new topic on Mirror Node, and the pause between looks. Defaults 10 and 2 000 ms. */
  verifyAttempts?: number;
  verifyDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with what is about to be created and what it may cost, after every check has passed and before anything is
   * paid for. Return false to cancel. When omitted the topic is created without asking: the CLI always provides it
   * (or requires `--yes`).
   */
  confirm?: (plan: CreationPlan) => Promise<boolean>;
}

/** Everything the person should know before agreeing to create the topic. */
export interface CreationPlan {
  network: string;
  chainId: number;
  operatorId: string;
  balance: HbarAmount;
  memo: string;
  withAdminKey: boolean;
  cost: CostEstimate;
}

export interface ProvisionSuccess {
  ok: true;
  /** `existing`: the configured topic is already usable, nothing was created. */
  status: "created" | "existing";
  network: string;
  topicId: string;
  /** Only when a topic was created. */
  transactionId?: string;
  hashscanTopicUrl: string | null;
  /** The line to put in `.env`. */
  envLine: string;
  /** True when Mirror Node confirmed the topic and its `submitKey` (it can lag a few seconds after creation). */
  verified: boolean;
  adminKey: boolean;
  /** `estimate` was shown before creating; `charged` is what Hedera really charged (null while not indexed). */
  cost: { estimate: CostEstimate | null; charged: ChargedFee | null };
  warnings: string[];
}

export interface ProvisionFailure {
  ok: false;
  /** Set when the Hedera environment itself is not usable (same report as `yarn setup`). */
  environment?: InvalidEnvironment;
  error: HcsPublishFailure;
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

const fail = (partial: Pick<HcsPublishFailure, "code" | "message" | "remediation"> & Partial<HcsPublishFailure>) =>
  ({
    ok: false,
    error: { outcome: "not_sent", retryable: false, ...partial },
  }) satisfies ProvisionFailure;

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function provisionHcsTopic(
  env: EnvironmentVariables,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const memo = options.memo ?? DEFAULT_TOPIC_MEMO;
  if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
    return fail({
      code: "CONFIG_INVALID",
      message: `The topic memo is longer than ${MAX_MEMO_BYTES} bytes.`,
      remediation: "Use a shorter --memo.",
    });
  }
  const rawNetwork = env[HEDERA_ENV.NETWORK]?.trim();
  if (rawNetwork && !isNetworkName(rawNetwork)) {
    return fail({
      code: "CONFIG_INVALID",
      message: `${HEDERA_ENV.NETWORK} "${rawNetwork}" is not a supported network.`,
      remediation: "Use testnet, mainnet or local.",
    });
  }
  const network: HederaNetwork = getSelectedNetwork(env);
  if (network.name === "mainnet" && !options.allowMainnet) {
    return fail({
      code: "CONFIG_INVALID",
      message: "Creating a topic on mainnet spends real HBAR and is permanent.",
      remediation: "Run again with --allow-mainnet if you are sure.",
    });
  }

  // 1. The Hedera environment (#5): network, account, key and balance. Nothing is sent while it is not valid.
  const environment = await validateHederaEnvironment(env, options);
  if (!environment.ok) {
    return {
      ok: false,
      environment,
      error: {
        code: environment.status === "unverified" ? "NETWORK_UNAVAILABLE" : "CONFIG_INVALID",
        outcome: "not_sent",
        retryable: environment.status === "unverified",
        message: "The Hedera environment is not valid, so no topic was created.",
        remediation: "Fix the problems reported by `yarn setup` first.",
      },
    };
  }

  const inspect = options.inspectKey ?? inspectPrivateKey;
  const publisherKeys = (await inspect(env[HEDERA_ENV.OPERATOR_KEY] ?? "")) ?? [];

  // 2. Never create a second topic over a configured one.
  const configured = env[HCS_ENV.TOPIC_ID]?.trim();
  if (configured) {
    if (!isValidTopicId(configured)) {
      return fail({
        code: "CONFIG_INVALID",
        message: `${HCS_ENV.TOPIC_ID} is set but is not a valid topic id.`,
        remediation: `Fix it, or empty ${HCS_ENV.TOPIC_ID} in .env to create a new topic.`,
      });
    }
    const checked = await verifyHcsTopic(network, configured, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      publisherKeys,
    });
    if (!checked.ok) {
      return {
        ok: false,
        error: {
          ...checked.error,
          remediation: `${checked.error.remediation} To create a new topic instead, empty ${HCS_ENV.TOPIC_ID} in .env and run this again.`,
        },
      };
    }
    return {
      ok: true,
      status: "existing",
      network: network.name,
      topicId: configured,
      hashscanTopicUrl: hashscanTopicUrl(network, configured),
      envLine: `${HCS_ENV.TOPIC_ID}=${configured}`,
      verified: true,
      adminKey: false,
      cost: { estimate: null, charged: null },
      warnings: [],
    };
  }

  // 3. Say what will happen and what it may cost, and ask. Nothing is paid for before this returns true.
  const withAdminKey = options.withAdminKey === true;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const usdPerHbar = await fetchUsdPerHbar(network, fetchImpl);
  const estimate = buildCostEstimate(network, usdPerHbar);
  if (options.confirm) {
    const accepted = await options.confirm({
      network: network.name,
      chainId: network.chainId,
      operatorId: environment.accountId,
      balance: environment.balance,
      memo,
      withAdminKey,
      cost: estimate,
    });
    if (!accepted) {
      return fail({
        code: "CANCELLED",
        message: "No topic was created.",
        remediation: "Run the command again when you want to create it.",
      });
    }
  }

  // 4. Create it. One attempt only.
  const createTimeoutMs = options.createTimeoutMs ?? 30_000;
  let close = () => {};
  let creator = options.creator;
  if (!creator) {
    try {
      const operator = await createOperatorClient(env, network, options.fetch);
      close = operator.close;
      creator = createHieroTopicCreator({
        client: operator.client,
        key: operator.key,
        sdk: operator.sdk as never,
      });
    } catch (error) {
      return { ok: false, error: classifyPublishError(error) };
    }
  }

  let transactionId: string | undefined;
  let created: { topicId: string; transactionId: string };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    created = await Promise.race([
      creator.create({
        memo,
        withAdminKey,
        timeoutMs: createTimeoutMs,
        onTransactionId: id => {
          transactionId = id;
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HcsTimeoutError(createTimeoutMs)), createTimeoutMs);
      }),
    ]);
  } catch (error) {
    const failure = classifyPublishError(error, { transactionId, timeoutMs: createTimeoutMs });
    return {
      ok: false,
      error:
        failure.outcome === "unknown"
          ? {
              ...failure,
              // Creation, unlike publishing, is not benign to repeat: it would leave a second, unused topic.
              remediation: `The topic may have been created. Check the operator account on HashScan${transactionId ? ` (transaction ${transactionId})` : ""} before running this again, so you do not create a duplicate.`,
              retryable: false,
            }
          : failure,
    };
  } finally {
    clearTimeout(timer);
    close();
  }

  // 5. Confirm on Mirror Node that the topic exists with the right submitKey. It can take a few seconds to appear.
  const sleep = options.sleep ?? defaultSleep;
  const attempts = Math.max(1, options.verifyAttempts ?? 10);
  let verified = false;
  const warnings: string[] = [];
  for (let attempt = 0; attempt < attempts && !verified; attempt++) {
    const checked = await verifyHcsTopic(network, created.topicId, {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      publisherKeys,
    });
    if (checked.ok) {
      verified = true;
    } else if (checked.error.code === "TOPIC_NOT_WRITABLE") {
      return { ok: false, error: { ...checked.error, transactionId: created.transactionId } };
    } else if (attempt < attempts - 1) {
      await sleep(options.verifyDelayMs ?? 2_000);
    }
  }
  if (!verified) {
    warnings.push(
      "The topic was created but Mirror Node did not show it yet; run `yarn setup` in a minute to confirm it.",
    );
  }
  // What Hedera really charged, once Mirror Node has the transaction (usually the same moment as the topic).
  const charged = verified
    ? await fetchChargedFee(network, toMirrorTransactionId(created.transactionId), usdPerHbar, fetchImpl)
    : null;
  if (withAdminKey) {
    warnings.push("The topic has an adminKey: keep the key safe, and omit it in production (ADR-001 §6.3).");
  }

  return {
    ok: true,
    status: "created",
    network: network.name,
    topicId: created.topicId,
    transactionId: created.transactionId,
    hashscanTopicUrl: hashscanTopicUrl(network, created.topicId),
    envLine: `${HCS_ENV.TOPIC_ID}=${created.topicId}`,
    verified,
    adminKey: withAdminKey,
    cost: { estimate, charged },
    warnings,
  };
}
