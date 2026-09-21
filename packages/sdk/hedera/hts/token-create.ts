/**
 * Provisioning of a development settlement token (`yarn hts:token`).
 *
 * Creates a fungible HTS token with the OPERATOR as treasury (and, for the `mint-transfer` model, as supply key), after
 * validating the environment (#5). This is for `HEDERA_HTS_CUSTODY=operator` (development/Testnet) only: in production the
 * `SettlementRouter` (#9) is deployed with its own treasury and supply key (ADR §6.7), not created by this command.
 * It is deliberately conservative because a token is permanent and costs HBAR:
 *  - it never creates a second token when `HEDERA_HTS_TOKEN_ID` already points to a usable one;
 *  - it refuses mainnet unless explicitly allowed;
 *  - it never retries: an `unknown` outcome tells the caller to look at the account before running it again.
 * No `console`, no prompts, no file access: `cli/hts-token.ts` is the presentation layer.
 */
import { ENV as HEDERA_ENV, inspectPrivateKey, validateHederaEnvironment } from "../environment";
import type {
  EnvironmentVariables,
  HbarAmount,
  InvalidEnvironment,
  KeyInspector,
  ValidateEnvironmentOptions,
} from "../environment";
import { hashscanTokenUrl, toMirrorTransactionId } from "../explorer";
import { getSelectedNetwork, isNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { fetchChargedFee, fetchUsdPerHbar } from "../cost";
import type { ChargedFee } from "../cost";
import { buildHtsCostEstimate } from "./cost";
import type { HtsCostEstimate } from "./cost";
import { HTS_ENV } from "./config";
import { isEntityId } from "./settlement";
import type { SettlementModel } from "./settlement";
import { HtsTimeoutError, classifyHtsError } from "./errors";
import type { HtsFailure } from "./errors";
import { createHtsMirror } from "./mirror";
import { createOperatorClient } from "../hcs/hiero-transport";

export const DEFAULT_TOKEN_NAME = "Verifiable Settlement Credit";
export const DEFAULT_TOKEN_SYMBOL = "HVS";
export const DEFAULT_DECIMALS = 0;
/** A `pool-transfer` token needs something to transfer; `mint-transfer` mints on demand and starts at zero. */
export const DEFAULT_POOL_INITIAL_SUPPLY = 1_000_000n;
const MAX_MEMO_BYTES = 100;
const MAX_SYMBOL_BYTES = 32; // Hedera's limit for a token symbol
const MAX_NAME_BYTES = 100; // Hedera's limit for a token name

// ---------------------------------------------------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------------------------------------------------

export interface CreateTokenRequest {
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: bigint;
  /** Sets the operator as supply key (needed by the `mint-transfer` model). */
  withSupplyKey: boolean;
  /** Also sets the operator as admin key (lets the token be updated or deleted). */
  withAdminKey: boolean;
  memo: string;
  timeoutMs: number;
  /** Called as soon as the transaction id exists, before sending, so a timeout can still report it. */
  onTransactionId(transactionId: string): void;
}

/** Creates one fungible token with the operator as treasury. Must not retry. */
export interface TokenCreator {
  create(request: CreateTokenRequest): Promise<{ tokenId: string; transactionId: string }>;
}

// Minimal structural view of the SDK, so the adapter is testable with fakes.
export interface TokenCreateTransactionLike {
  setTokenName(name: string): this;
  setTokenSymbol(symbol: string): this;
  setTokenType(type: unknown): this;
  setSupplyType(type: unknown): this;
  setDecimals(decimals: number): this;
  setInitialSupply(amount: bigint): this;
  setTreasuryAccountId(accountId: string): this;
  setSupplyKey(key: unknown): this;
  setAdminKey(key: unknown): this;
  setTokenMemo(memo: string): this;
  setRegenerateTransactionId(regenerate: boolean): this;
  setMaxAttempts(attempts: number): this;
  setGrpcDeadline(milliseconds: number): this;
  freezeWith(client: unknown): this;
  readonly transactionId: { toString(): string } | null;
  execute(client: unknown): Promise<{
    transactionId: { toString(): string };
    getReceipt(client: unknown): Promise<{ tokenId: { toString(): string } | null }>;
  }>;
}
export interface HieroTokenSdkLike {
  TokenCreateTransaction: new () => TokenCreateTransactionLike;
  TokenType: { FungibleCommon: unknown };
  TokenSupplyType: { Infinite: unknown };
}

export function createHieroTokenCreator(options: {
  client: unknown;
  operatorId: string;
  /** The operator private key object; only its public key is used. */
  key: { publicKey: unknown };
  sdk: HieroTokenSdkLike;
}): TokenCreator {
  return {
    async create(request) {
      let transaction = new options.sdk.TokenCreateTransaction()
        .setTokenName(request.name)
        .setTokenSymbol(request.symbol)
        .setTokenType(options.sdk.TokenType.FungibleCommon)
        .setSupplyType(options.sdk.TokenSupplyType.Infinite)
        .setDecimals(request.decimals)
        .setInitialSupply(request.initialSupply)
        .setTreasuryAccountId(options.operatorId)
        .setTokenMemo(request.memo)
        .setRegenerateTransactionId(false)
        .setMaxAttempts(3)
        .setGrpcDeadline(Math.max(1_000, Math.floor(request.timeoutMs / 2)));
      if (request.withSupplyKey) transaction = transaction.setSupplyKey(options.key.publicKey);
      if (request.withAdminKey) transaction = transaction.setAdminKey(options.key.publicKey);
      transaction.freezeWith(options.client);
      if (transaction.transactionId) request.onTransactionId(transaction.transactionId.toString());

      const response = await transaction.execute(options.client);
      request.onTransactionId(response.transactionId.toString());
      const receipt = await response.getReceipt(options.client);
      const tokenId = receipt.tokenId?.toString();
      if (!tokenId) throw Object.assign(new Error("the receipt has no token id"), { name: "MissingTokenId" });
      return { tokenId, transactionId: response.transactionId.toString() };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------------------------------------------------

export interface ProvisionTokenOptions extends Pick<ValidateEnvironmentOptions, "fetch" | "timeoutMs" | "now"> {
  /** Overrides the creator (tests). When set, no Hedera client is created. */
  creator?: TokenCreator;
  inspectKey?: KeyInspector;
  name?: string;
  symbol?: string;
  decimals?: number;
  initialSupply?: bigint;
  /** `mint-transfer` (default) sets the operator as supply key; `pool-transfer` does not, unless `withSupplyKey` is set. */
  model?: SettlementModel;
  withSupplyKey?: boolean;
  withAdminKey?: boolean;
  memo?: string;
  /** Creating a token on mainnet spends real HBAR (about US$ 1) and is refused unless this is true. */
  allowMainnet?: boolean;
  /** Deadline of the creation transaction. Default 30 000 ms. */
  createTimeoutMs?: number;
  /** How many times to look for the new token on Mirror Node, and the pause between looks. Defaults 10 and 2 000 ms. */
  verifyAttempts?: number;
  verifyDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with what is about to be created and what it may cost, after every check has passed and before anything is
   * paid for. Return false to cancel. When omitted the token is created without asking: the CLI always provides it
   * (or requires `--yes`).
   */
  confirm?: (plan: TokenCreationPlan) => Promise<boolean>;
}

/** Everything the person should know before agreeing to create the token. */
export interface TokenCreationPlan {
  network: string;
  chainId: number;
  operatorId: string;
  balance: HbarAmount;
  name: string;
  symbol: string;
  decimals: number;
  initialSupply: string;
  model: SettlementModel;
  withSupplyKey: boolean;
  withAdminKey: boolean;
  cost: HtsCostEstimate;
}

export interface ProvisionTokenSuccess {
  ok: true;
  /** `existing`: the configured token is already usable, nothing was created. */
  status: "created" | "existing";
  network: string;
  tokenId: string;
  /** Only when a token was created. */
  transactionId?: string;
  hashscanTokenUrl: string | null;
  /** The `.env` lines to set. */
  envLines: string[];
  /** True when Mirror Node confirmed the token and its treasury/supply key (it can lag a few seconds after creation). */
  verified: boolean;
  supplyKey: boolean;
  adminKey: boolean;
  /** `estimate` was shown before creating; `charged` is what Hedera really charged (null while not indexed). */
  cost: { estimate: HtsCostEstimate | null; charged: ChargedFee | null };
  warnings: string[];
}

export interface ProvisionTokenFailure {
  ok: false;
  /** Set when the Hedera environment itself is not usable (same report as `yarn setup`). */
  environment?: InvalidEnvironment;
  error: HtsFailure;
}

export type ProvisionTokenResult = ProvisionTokenSuccess | ProvisionTokenFailure;

const fail = (
  partial: Pick<HtsFailure, "code" | "message" | "remediation"> & Partial<HtsFailure>,
): ProvisionTokenFailure => ({
  ok: false,
  error: { outcome: "not_sent", operation: "preflight", retryable: false, ...partial },
});

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A token this command creates or confirms has the operator as treasury, so it is only usable with operator custody
 * (ADR §6.7's router custody expects the router itself as treasury). Returns the `.env` line to set, or none when it is
 * already `operator`.
 */
function custodyEnvLines(env: EnvironmentVariables): string[] {
  return env[HTS_ENV.CUSTODY]?.trim() === "operator" ? [] : [`${HTS_ENV.CUSTODY}=operator`];
}

/** Checks that a configured token is usable as a dev settlement token: exists, right treasury, right supply key. */
async function checkExistingToken(
  network: HederaNetwork,
  tokenId: string,
  operatorId: string,
  model: SettlementModel,
  operatorKeys: { publicKey: string }[],
  fetchImpl: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: HtsFailure }> {
  const mirror = createHtsMirror(network, { fetch: fetchImpl });
  let token;
  try {
    token = await mirror.getToken(tokenId);
  } catch (error) {
    return { ok: false, error: classifyHtsError(error, { operation: "preflight", tokenId }) };
  }
  if (!token || token.deleted) {
    return {
      ok: false,
      error: {
        code: "TOKEN_NOT_FOUND",
        outcome: "not_sent",
        operation: "preflight",
        message: `${HTS_ENV.TOKEN_ID} is set to ${tokenId}, which does not exist or was deleted on ${network.name}.`,
        remediation: `Fix it, or empty ${HTS_ENV.TOKEN_ID} in .env to create a new token.`,
        retryable: false,
        tokenId,
      },
    };
  }
  if (token.treasuryAccountId !== operatorId) {
    return {
      ok: false,
      error: {
        code: "CONFIG_INVALID",
        outcome: "not_sent",
        operation: "preflight",
        message: `The treasury of token ${tokenId} is ${token.treasuryAccountId}, not the operator ${operatorId}.`,
        remediation: `Use a token whose treasury is the operator, or empty ${HTS_ENV.TOKEN_ID} in .env to create a new one.`,
        retryable: false,
        tokenId,
      },
    };
  }
  if (model === "mint-transfer") {
    const matches = token.supplyKey && operatorKeys.some(k => k.publicKey.toLowerCase() === token.supplyKey?.key);
    if (!matches) {
      return {
        ok: false,
        error: {
          code: "NO_MINT_PERMISSION",
          outcome: "not_sent",
          operation: "preflight",
          message: `The supply key of token ${tokenId} is not the operator, so it cannot be minted (model mint-transfer).`,
          remediation: `Use a token whose supply key is the operator, empty ${HTS_ENV.TOKEN_ID} to create a new one, or set HEDERA_HTS_SETTLEMENT_MODEL=pool-transfer.`,
          retryable: false,
          tokenId,
        },
      };
    }
  }
  return { ok: true };
}

export async function provisionHtsToken(
  env: EnvironmentVariables,
  options: ProvisionTokenOptions = {},
): Promise<ProvisionTokenResult> {
  const name = options.name ?? DEFAULT_TOKEN_NAME;
  const symbol = options.symbol ?? DEFAULT_TOKEN_SYMBOL;
  const decimals = options.decimals ?? DEFAULT_DECIMALS;
  const model: SettlementModel = options.model ?? "mint-transfer";
  const memo = options.memo ?? "verifiable-settlement dev token";
  if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
    return fail({
      code: "CONFIG_INVALID",
      message: `The token memo is longer than ${MAX_MEMO_BYTES} bytes.`,
      remediation: "Use a shorter --memo.",
    });
  }
  if (new TextEncoder().encode(symbol).length > MAX_SYMBOL_BYTES) {
    return fail({
      code: "CONFIG_INVALID",
      message: `The token symbol is longer than ${MAX_SYMBOL_BYTES} bytes.`,
      remediation: "Use a shorter --symbol.",
    });
  }
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) {
    return fail({
      code: "CONFIG_INVALID",
      message: `The token name is longer than ${MAX_NAME_BYTES} bytes.`,
      remediation: "Use a shorter --name.",
    });
  }
  if (decimals < 0 || decimals > 18 || !Number.isInteger(decimals)) {
    return fail({
      code: "CONFIG_INVALID",
      message: "decimals must be an integer between 0 and 18.",
      remediation: "Use --decimals 0-18.",
    });
  }
  const withSupplyKey = options.withSupplyKey ?? model === "mint-transfer";
  const initialSupply =
    options.initialSupply ?? (model === "pool-transfer" && !withSupplyKey ? DEFAULT_POOL_INITIAL_SUPPLY : 0n);
  if (!withSupplyKey && initialSupply === 0n) {
    return fail({
      code: "CONFIG_INVALID",
      message:
        "Without a supply key, the token can never be minted, so it needs an initial supply to be usable as a pool.",
      remediation: "Pass --initial-supply, or omit --no-supply-key to let this token be minted.",
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
      message: "Creating a token on mainnet spends real HBAR (about US$ 1) and is permanent.",
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
        operation: "preflight",
        retryable: environment.status === "unverified",
        message: "The Hedera environment is not valid, so no token was created.",
        remediation: "Fix the problems reported by `yarn setup` first.",
      },
    };
  }

  const inspect = options.inspectKey ?? inspectPrivateKey;
  const operatorKeys = (await inspect(env[HEDERA_ENV.OPERATOR_KEY] ?? "")) ?? [];
  const fetchImpl = options.fetch ?? globalThis.fetch;

  // 2. Never create a second token over a configured one.
  const configured = env[HTS_ENV.TOKEN_ID]?.trim();
  if (configured) {
    if (!isEntityId(configured)) {
      return fail({
        code: "CONFIG_INVALID",
        message: `${HTS_ENV.TOKEN_ID} is set but is not a valid token id.`,
        remediation: `Fix it, or empty ${HTS_ENV.TOKEN_ID} in .env to create a new token.`,
      });
    }
    const checked = await checkExistingToken(
      network,
      configured,
      environment.accountId,
      model,
      operatorKeys,
      fetchImpl,
    );
    if (!checked.ok)
      return {
        ok: false,
        error: {
          ...checked.error,
          remediation: `${checked.error.remediation} To create a new token instead, empty ${HTS_ENV.TOKEN_ID} in .env and run this again.`,
        },
      };
    return {
      ok: true,
      status: "existing",
      network: network.name,
      tokenId: configured,
      hashscanTokenUrl: hashscanTokenUrl(network, configured),
      envLines: [`${HTS_ENV.TOKEN_ID}=${configured}`, ...custodyEnvLines(env)],
      verified: true,
      supplyKey: model === "mint-transfer",
      adminKey: false,
      cost: { estimate: null, charged: null },
      warnings: [],
    };
  }

  // 3. Say what will happen and what it may cost, and ask. Nothing is paid for before this returns true.
  const withAdminKey = options.withAdminKey === true;
  const usdPerHbar = await fetchUsdPerHbar(network, fetchImpl);
  const estimate = buildHtsCostEstimate(network, usdPerHbar);
  if (options.confirm) {
    const accepted = await options.confirm({
      network: network.name,
      chainId: network.chainId,
      operatorId: environment.accountId,
      balance: environment.balance,
      name,
      symbol,
      decimals,
      initialSupply: initialSupply.toString(),
      model,
      withSupplyKey,
      withAdminKey,
      cost: estimate,
    });
    if (!accepted)
      return fail({
        code: "CANCELLED",
        message: "No token was created.",
        remediation: "Run the command again when you want to create it.",
      });
  }

  // 4. Create it. One attempt only.
  const createTimeoutMs = options.createTimeoutMs ?? 30_000;
  let close = () => {};
  let creator = options.creator;
  if (!creator) {
    try {
      const operator = await createOperatorClient(env, network, fetchImpl);
      close = operator.close;
      creator = createHieroTokenCreator({
        client: operator.client,
        operatorId: environment.accountId,
        key: operator.key,
        sdk: operator.sdk as never,
      });
    } catch (error) {
      const failure = (error as { failure?: HtsFailure } | null)?.failure;
      return { ok: false, error: failure ?? classifyHtsError(error, { operation: "preflight" }) };
    }
  }

  let transactionId: string | undefined;
  let created: { tokenId: string; transactionId: string };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    created = await Promise.race([
      creator.create({
        name,
        symbol,
        decimals,
        initialSupply,
        withSupplyKey,
        withAdminKey,
        memo,
        timeoutMs: createTimeoutMs,
        onTransactionId: id => {
          transactionId = id;
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HtsTimeoutError(createTimeoutMs)), createTimeoutMs);
      }),
    ]);
  } catch (error) {
    const failure = classifyHtsError(error, { operation: "preflight", transactionId, timeoutMs: createTimeoutMs });
    return {
      ok: false,
      error:
        failure.outcome === "unknown"
          ? {
              ...failure,
              // Creation, unlike a settlement, is not benign to repeat: it would leave a second, unused token.
              remediation: `The token may have been created. Check the operator account on HashScan${transactionId ? ` (transaction ${transactionId})` : ""} before running this again, so you do not create a duplicate.`,
              retryable: false,
            }
          : failure,
    };
  } finally {
    clearTimeout(timer);
    close();
  }

  // 5. Confirm on Mirror Node that the token exists with the right treasury/supply key. It can take a few seconds to appear.
  const sleep = options.sleep ?? defaultSleep;
  const attempts = Math.max(1, options.verifyAttempts ?? 10);
  let verified = false;
  const warnings: string[] = [];
  for (let attempt = 0; attempt < attempts && !verified; attempt++) {
    const checked = await checkExistingToken(
      network,
      created.tokenId,
      environment.accountId,
      model,
      operatorKeys,
      fetchImpl,
    );
    if (checked.ok) {
      verified = true;
    } else if (checked.error.code === "CONFIG_INVALID" || checked.error.code === "NO_MINT_PERMISSION") {
      return { ok: false, error: { ...checked.error, transactionId: created.transactionId } };
    } else if (attempt < attempts - 1) {
      await sleep(options.verifyDelayMs ?? 2_000);
    }
  }
  if (!verified) {
    warnings.push(
      "The token was created but Mirror Node did not show it yet; run `yarn hts:settle preflight` in a minute to confirm it.",
    );
  }
  const charged = verified
    ? await fetchChargedFee(network, toMirrorTransactionId(created.transactionId), usdPerHbar, fetchImpl)
    : null;
  if (withAdminKey)
    warnings.push("The token has an adminKey: keep the key safe, and omit it in production (ADR-001 §6.7).");
  if (!withSupplyKey)
    warnings.push(
      "The token has no supply key: it can never be minted. Use it only with HEDERA_HTS_SETTLEMENT_MODEL=pool-transfer.",
    );

  const envLines = [`${HTS_ENV.TOKEN_ID}=${created.tokenId}`, ...custodyEnvLines(env)];
  if (model === "pool-transfer") envLines.push(`${HTS_ENV.MODEL}=pool-transfer`);

  return {
    ok: true,
    status: "created",
    network: network.name,
    tokenId: created.tokenId,
    transactionId: created.transactionId,
    hashscanTokenUrl: hashscanTokenUrl(network, created.tokenId),
    envLines,
    verified,
    supplyKey: withSupplyKey,
    adminKey: withAdminKey,
    cost: { estimate, charged },
    warnings,
  };
}
