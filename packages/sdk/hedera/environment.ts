/**
 * Hedera environment validation.
 *
 * Single source of truth for "is this environment usable?": network, operator account and balance. It is a pure
 * module: it reads the environment it is given, talks to the network only through an injectable `fetch`, and returns
 * data. It never prints, prompts or exits, so the setup command, the dashboard and CI can all reuse it.
 *
 * Security: no result, issue or message contains a private key, and URLs are reduced to their origin. Errors thrown by
 * key parsing are discarded because the Hedera SDK echoes the rejected input in them.
 */
import { TINYBARS_PER_HBAR, formatHbar } from "./hbar";
import { NETWORKS, getNetwork, selectedNetworkName } from "./networks";
import type { HederaNetworkName } from "./networks";

export { formatHbar };

/** Environment variables read by the validator. */
export const ENV = {
  NETWORK: "HEDERA_NETWORK",
  OPERATOR_ID: "HEDERA_OPERATOR_ID",
  OPERATOR_KEY: "HEDERA_OPERATOR_KEY",
  MIRROR_NODE_URL: "HEDERA_MIRROR_NODE_URL",
  MIN_BALANCE_HBAR: "HEDERA_MIN_BALANCE_HBAR",
} as const;

export type EnvironmentVariables = Record<string, string | undefined>;

export const FAUCET_URL = "https://portal.hedera.com/faucet";
const PORTAL_URL = "https://portal.hedera.com";

/**
 * Minimum operator balance per network, in HBAR. Starting points to be tuned once the real cost of the deployment and
 * setup flow is measured (issue #18); override with `HEDERA_MIN_BALANCE_HBAR`.
 */
export const DEFAULT_MIN_BALANCE_HBAR: Record<HederaNetworkName, string> = {
  testnet: "20",
  mainnet: "10",
  local: "1",
};

export type IssueSeverity = "error" | "warning";

/** Coarse grouping for consumers that only need to know *what kind* of problem it is. */
export type IssueCategory = "missing_env" | "network" | "account" | "key" | "balance" | "connectivity";

export type IssueCode =
  | "MISSING_ENV"
  | "INVALID_NETWORK"
  | "INVALID_URL"
  | "INVALID_ACCOUNT_ID"
  | "INVALID_OPERATOR_KEY"
  | "INVALID_MIN_BALANCE"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_DELETED"
  | "KEY_MISMATCH"
  | "INSUFFICIENT_BALANCE"
  | "NETWORK_MISMATCH"
  | "MIRROR_UNAVAILABLE"
  | "MAINNET_SELECTED"
  | "KEY_UNVERIFIABLE";

export interface EnvironmentIssue {
  code: IssueCode;
  category: IssueCategory;
  severity: IssueSeverity;
  /** The environment variable at fault, when there is one. */
  variable?: string;
  /** What is wrong. Contains no secret. */
  message: string;
  /** What the developer should do about it. */
  remediation: string;
  /** Machine-readable, non-sensitive context. */
  details?: Record<string, string | number | boolean>;
}

export interface HbarAmount {
  /** Integer tinybars as a decimal string (exact; also safe to serialize as JSON). */
  tinybars: string;
  /** Human-readable HBAR, e.g. "1234.5". */
  hbar: string;
}

export interface ValidEnvironment {
  ok: true;
  status: "valid";
  network: HederaNetworkName;
  accountId: string;
  balance: HbarAmount;
  minimumBalance: HbarAmount;
  /** HashScan URL of the account on the validated network; null for networks without a public explorer. */
  hashscanUrl: string | null;
  /** Origin (no path or credentials) of the Mirror Node that answered. */
  mirrorNodeOrigin: string;
  /** True when the private key was checked against the account's key on the network. */
  keyVerified: boolean;
  /**
   * Curve of the operator key, taken from the account when the key was verified. A raw 32-byte hex key is valid for both
   * curves, so this is what tells a client how to parse it. Null when the key could not be checked.
   */
  keyType: PublicKeyCandidate["type"] | null;
  warnings: EnvironmentIssue[];
  checkedAt: string;
}

export interface InvalidEnvironment {
  ok: false;
  /**
   * `invalid`: a configuration problem the developer must fix.
   * `unverified`: only connectivity problems; nothing could be verified and the configuration is not proven wrong.
   */
  status: "invalid" | "unverified";
  network?: HederaNetworkName;
  accountId?: string;
  issues: EnvironmentIssue[];
  warnings: EnvironmentIssue[];
  checkedAt: string;
}

export type EnvironmentValidation = ValidEnvironment | InvalidEnvironment;

export interface PublicKeyCandidate {
  type: "ED25519" | "ECDSA_SECP256K1";
  /** Lowercase hex, in the encoding the Mirror Node uses (32 bytes for ED25519, 33 compressed for ECDSA). */
  publicKey: string;
}

/** Derives the public key(s) a private key may correspond to; `null` when the input is not a private key. */
export type KeyInspector = (privateKey: string) => Promise<PublicKeyCandidate[] | null>;

export interface ValidateEnvironmentOptions {
  /** HTTP client. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /** Require the operator private key. Default true. Read-only consumers (e.g. a dashboard) may pass false. */
  requireOperatorKey?: boolean;
  /** Overrides the minimum balance, in tinybars. Takes precedence over the environment. */
  minBalanceTinybars?: bigint;
  /** Overrides how private keys are inspected. Defaults to the Hedera SDK. */
  inspectKey?: KeyInspector;
  /** Look for the account on the other public network when it is not found. Default true. */
  crossCheckNetworks?: boolean;
  /** Clock, for deterministic tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Parses a positive decimal HBAR amount (up to 8 decimals) into tinybars without floating point. */
export function parseHbar(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (!match) return null;
  const tinybars = BigInt(match[1]) * TINYBARS_PER_HBAR + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  return tinybars > 0n ? tinybars : null;
}

const toAmount = (tinybars: bigint): HbarAmount => ({ tinybars: tinybars.toString(), hbar: formatHbar(tinybars) });

/** Reduces a URL to `protocol//host` so credentials, paths and query strings (API keys) never leave this module. */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "<invalid url>";
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Account ID of the form `shard.realm.num`. */
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LOOKS_LIKE_KEY = /^(0x)?([0-9a-fA-F]{64}|[0-9a-fA-F]{96}|[0-9a-fA-F]{100}|30[0-9a-fA-F]{60,})$/;

/** Known public hosts per network, used to catch an endpoint that belongs to another network without any request. */
function networkOfHost(host: string): HederaNetworkName | null {
  for (const name of Object.keys(NETWORKS) as HederaNetworkName[]) {
    const known = [parseHttpUrl(NETWORKS[name].mirrorNodeUrl)?.host];
    if (known.includes(host)) return name;
  }
  return null;
}

/** The other public networks to look at when something does not match (none for a local network or when disabled). */
function crossCheckTargets(name: HederaNetworkName, options: ValidateEnvironmentOptions): HederaNetworkName[] {
  if (options.crossCheckNetworks === false || name === "local") return [];
  return (["testnet", "mainnet"] as const).filter(n => n !== name);
}

function issue(
  code: IssueCode,
  category: IssueCategory,
  message: string,
  remediation: string,
  extra: { severity?: IssueSeverity; variable?: string; details?: EnvironmentIssue["details"] } = {},
): EnvironmentIssue {
  const { severity = "error", variable, details } = extra;
  return { code, category, severity, message, remediation, ...(variable && { variable }), ...(details && { details }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Key inspection (Hedera SDK, loaded lazily so importing this module stays cheap)
// ---------------------------------------------------------------------------------------------------------------------

/** Default {@link KeyInspector}. Never throws and never lets the SDK's error text (which echoes the input) escape. */
export const inspectPrivateKey: KeyInspector = async input => {
  const value = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  try {
    const { PrivateKey } = await import("@hashgraph/sdk");
    const candidates: PublicKeyCandidate[] = [];
    if (value.length === 64) {
      // A raw 32-byte key is valid for both curves; the account's key decides which one it is.
      const attempts: [PublicKeyCandidate["type"], () => { publicKey: { toStringRaw(): string } }][] = [
        ["ED25519", () => PrivateKey.fromStringED25519(value)],
        ["ECDSA_SECP256K1", () => PrivateKey.fromStringECDSA(value)],
      ];
      for (const [type, parse] of attempts) {
        try {
          candidates.push({ type, publicKey: parse().publicKey.toStringRaw().toLowerCase() });
        } catch {
          // Not valid for this curve.
        }
      }
    } else if (value.startsWith("30")) {
      const key = PrivateKey.fromStringDer(value);
      candidates.push({
        type: String(key.type).toLowerCase().startsWith("ed") ? "ED25519" : "ECDSA_SECP256K1",
        publicKey: key.publicKey.toStringRaw().toLowerCase(),
      });
    }
    return candidates.length > 0 ? candidates : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// Mirror Node access
// ---------------------------------------------------------------------------------------------------------------------

type MirrorAccount = {
  deleted: boolean;
  balanceTinybars: bigint;
  key: { type: string; key: string } | null;
};

type MirrorLookup =
  { kind: "found"; account: MirrorAccount } | { kind: "not_found" } | { kind: "unavailable"; reason: string };

/**
 * The balance is read from the raw response text: large accounts exceed 2^53 tinybars (the testnet treasury holds more
 * than 3×10^18), which `JSON.parse` would round.
 */
const BALANCE_PATTERN = /"balance"\s*:\s*\{\s*"balance"\s*:\s*(\d+)/;

async function lookupAccount(
  fetchImpl: typeof fetch,
  mirrorUrl: string,
  accountId: string,
  timeoutMs: number,
): Promise<MirrorLookup> {
  const url = `${mirrorUrl.replace(/\/+$/, "")}/api/v1/accounts/${encodeURIComponent(accountId)}?transactions=false`;
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { kind: "not_found" };
    text = await response.text();
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { kind: "unavailable", reason: timedOut ? "timeout" : "network error" };
  }
  if (response.status === 429) return { kind: "unavailable", reason: "rate limited (HTTP 429)" };
  if (!response.ok) return { kind: "unavailable", reason: `HTTP ${response.status}` };

  const balance = BALANCE_PATTERN.exec(text);
  let body: { deleted?: unknown; key?: { _type?: unknown; key?: unknown } | null };
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "unavailable", reason: "unexpected response" };
  }
  if (!balance || typeof body !== "object" || body === null)
    return { kind: "unavailable", reason: "unexpected response" };

  const key =
    body.key && typeof body.key._type === "string" && typeof body.key.key === "string"
      ? { type: body.key._type, key: body.key.key.toLowerCase() }
      : null;
  return { kind: "found", account: { deleted: body.deleted === true, balanceTinybars: BigInt(balance[1]), key } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Validates network, operator account and balance. Configuration problems are collected first (all missing variables
 * are reported together) and no request is made while any exist. Never throws for an invalid environment.
 */
export async function validateHederaEnvironment(
  env: EnvironmentVariables,
  options: ValidateEnvironmentOptions = {},
): Promise<EnvironmentValidation> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const requireKey = options.requireOperatorKey ?? true;
  const inspectKey = options.inspectKey ?? inspectPrivateKey;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();

  const issues: EnvironmentIssue[] = [];
  const warnings: EnvironmentIssue[] = [];
  const read = (name: string) => env[name]?.trim() || undefined;

  // 1. Network -------------------------------------------------------------------------------------------------------
  let networkName: HederaNetworkName | undefined;
  try {
    networkName = selectedNetworkName(env);
  } catch {
    const raw = read(ENV.NETWORK) ?? "";
    const shown = /^[\w-]{1,20}$/.test(raw) ? ` "${raw}"` : "";
    issues.push(
      issue(
        "INVALID_NETWORK",
        "network",
        `${ENV.NETWORK}${shown} is not a supported network.`,
        `Set ${ENV.NETWORK} to one of: ${Object.keys(NETWORKS).join(", ")}. Leave it empty to use testnet.`,
        { variable: ENV.NETWORK },
      ),
    );
  }
  const network = networkName ? getNetwork(networkName, env) : undefined;

  // 2. Endpoint overrides: well-formed, and not pointing at another network ------------------------------------------
  for (const variable of [ENV.MIRROR_NODE_URL]) {
    const raw = read(variable);
    if (!raw) continue;
    const url = parseHttpUrl(raw);
    if (!url) {
      issues.push(
        issue(
          "INVALID_URL",
          "network",
          `${variable} is not a valid http(s) URL.`,
          `Set ${variable} to a full URL such as https://host/path, or unset it to use the default for the selected network.`,
          { variable },
        ),
      );
      continue;
    }
    const owner = networkOfHost(url.host);
    if (networkName && owner && owner !== networkName) {
      issues.push(
        issue(
          "NETWORK_MISMATCH",
          "network",
          `${variable} points to the ${owner} endpoint (${url.host}) but ${ENV.NETWORK} is ${networkName}.`,
          `Use the ${networkName} endpoint, unset ${variable}, or change ${ENV.NETWORK} to ${owner}.`,
          { variable, details: { configuredNetwork: networkName, detectedNetwork: owner } },
        ),
      );
    }
  }

  // 3. Operator account ----------------------------------------------------------------------------------------------
  const accountId = read(ENV.OPERATOR_ID);
  if (!accountId) {
    issues.push(
      issue(
        "MISSING_ENV",
        "missing_env",
        `${ENV.OPERATOR_ID} is not set or is empty.`,
        `Run \`cp .env.example .env\` if you have not, then set ${ENV.OPERATOR_ID}=0.0.<your account>. Create a testnet account at ${PORTAL_URL}.`,
        { variable: ENV.OPERATOR_ID },
      ),
    );
  } else if (!ACCOUNT_ID.test(accountId)) {
    const hint = EVM_ADDRESS.test(accountId)
      ? "That looks like an EVM address; a Hedera account ID (shard.realm.num, e.g. 0.0.1234) is required. Look the address up on HashScan to find its account ID."
      : LOOKS_LIKE_KEY.test(accountId)
        ? `That looks like a private key. Put it in ${ENV.OPERATOR_KEY} and set ${ENV.OPERATOR_ID} to the account ID (e.g. 0.0.1234).`
        : accountId.includes("-")
          ? "Remove the checksum suffix (the part after the dash) and use the plain shard.realm.num form."
          : "Use the account ID shown on the Hedera Portal or HashScan, in the form 0.0.1234.";
    issues.push(
      issue("INVALID_ACCOUNT_ID", "account", `${ENV.OPERATOR_ID} is not a valid Hedera account ID.`, hint, {
        variable: ENV.OPERATOR_ID,
      }),
    );
  }
  const validAccountId = accountId && ACCOUNT_ID.test(accountId) ? accountId : undefined;

  // 4. Operator key --------------------------------------------------------------------------------------------------
  let keyCandidates: PublicKeyCandidate[] | null = null;
  const rawKey = read(ENV.OPERATOR_KEY);
  if (!rawKey && requireKey) {
    issues.push(
      issue(
        "MISSING_ENV",
        "missing_env",
        `${ENV.OPERATOR_KEY} is not set or is empty.`,
        `Set ${ENV.OPERATOR_KEY} in .env to the private key of ${ENV.OPERATOR_ID} (from ${PORTAL_URL}). Keep it secret and never commit it.`,
        { variable: ENV.OPERATOR_KEY },
      ),
    );
  } else if (rawKey) {
    keyCandidates = await inspectKey(rawKey);
    if (!keyCandidates || keyCandidates.length === 0) {
      keyCandidates = null;
      issues.push(
        issue(
          "INVALID_OPERATOR_KEY",
          "key",
          `${ENV.OPERATOR_KEY} is not a valid Hedera private key.`,
          "Provide the hex-encoded private key: DER-encoded, or a raw 32-byte hex string. A public key, an account ID or a mnemonic phrase will not work.",
          { variable: ENV.OPERATOR_KEY },
        ),
      );
    }
  }

  // 5. Minimum balance -----------------------------------------------------------------------------------------------
  let minBalance = options.minBalanceTinybars;
  const rawMin = read(ENV.MIN_BALANCE_HBAR);
  if (minBalance === undefined && rawMin) {
    const parsed = parseHbar(rawMin);
    if (parsed === null) {
      issues.push(
        issue(
          "INVALID_MIN_BALANCE",
          "balance",
          `${ENV.MIN_BALANCE_HBAR} is not a positive HBAR amount.`,
          `Use a positive decimal number of HBAR with at most 8 decimals, e.g. ${DEFAULT_MIN_BALANCE_HBAR.testnet}, or unset it to use the default.`,
          { variable: ENV.MIN_BALANCE_HBAR },
        ),
      );
    } else {
      minBalance = parsed;
    }
  }

  // Stop before any request while the configuration itself is broken.
  const invalid = (extra: Partial<InvalidEnvironment> = {}): InvalidEnvironment => ({
    ok: false,
    status: issues.every(i => i.category === "connectivity" || i.severity === "warning") ? "unverified" : "invalid",
    ...(networkName && { network: networkName }),
    ...(validAccountId && { accountId: validAccountId }),
    issues,
    warnings,
    checkedAt,
    ...extra,
  });
  if (issues.length > 0 || !network || !networkName || !validAccountId) return invalid();

  if (networkName === "mainnet") {
    warnings.push(
      issue(
        "MAINNET_SELECTED",
        "network",
        "The environment targets mainnet: operations spend real HBAR.",
        `If this is not intended, set ${ENV.NETWORK}=testnet.`,
        { severity: "warning", variable: ENV.NETWORK },
      ),
    );
  }
  minBalance ??= parseHbar(DEFAULT_MIN_BALANCE_HBAR[networkName]) as bigint;
  const origin = redactUrl(network.mirrorNodeUrl);

  // 6. Account on the configured network -----------------------------------------------------------------------------
  const lookup = await lookupAccount(fetchImpl, network.mirrorNodeUrl, validAccountId, timeoutMs);

  if (lookup.kind === "unavailable") {
    issues.push(
      issue(
        "MIRROR_UNAVAILABLE",
        "connectivity",
        `Could not verify the account: the Mirror Node at ${origin} did not answer (${lookup.reason}).`,
        `Check your connection and retry. To use another endpoint set ${ENV.MIRROR_NODE_URL}. Nothing was verified; this is not necessarily a configuration error.`,
        { variable: ENV.MIRROR_NODE_URL, details: { reason: lookup.reason } },
      ),
    );
    return invalid();
  }

  if (lookup.kind === "not_found") {
    const other = crossCheckTargets(networkName, options);
    for (const candidate of other) {
      const elsewhere = await lookupAccount(fetchImpl, NETWORKS[candidate].mirrorNodeUrl, validAccountId, timeoutMs);
      if (elsewhere.kind === "found") {
        issues.push(
          issue(
            "NETWORK_MISMATCH",
            "network",
            `Account ${validAccountId} exists on ${candidate}, but ${ENV.NETWORK} is ${networkName}.`,
            `Set ${ENV.NETWORK}=${candidate} to use this account, or set ${ENV.OPERATOR_ID} to an account created on ${networkName}.`,
            { variable: ENV.NETWORK, details: { configuredNetwork: networkName, foundOn: candidate } },
          ),
        );
        return invalid();
      }
    }
    issues.push(
      issue(
        "ACCOUNT_NOT_FOUND",
        "account",
        `Account ${validAccountId} does not exist on ${networkName} (checked ${origin}).`,
        networkName === "testnet"
          ? `Check ${ENV.OPERATOR_ID}. Testnet is reset periodically and account IDs change when it is (keys are kept): create a new account at ${PORTAL_URL} and update ${ENV.OPERATOR_ID} and ${ENV.OPERATOR_KEY}.`
          : `Check ${ENV.OPERATOR_ID} against the account on HashScan for ${networkName}, and make sure it was created on that network.`,
        { variable: ENV.OPERATOR_ID, details: { network: networkName } },
      ),
    );
    return invalid();
  }

  const account = lookup.account;
  if (account.deleted) {
    issues.push(
      issue(
        "ACCOUNT_DELETED",
        "account",
        `Account ${validAccountId} was deleted on ${networkName} and cannot be used.`,
        `Create a new account and set ${ENV.OPERATOR_ID} and ${ENV.OPERATOR_KEY} to it.`,
        { variable: ENV.OPERATOR_ID },
      ),
    );
  }

  // 7. Key belongs to the account ------------------------------------------------------------------------------------
  // Account numbers overlap between networks (the same 0.0.N exists on testnet and mainnet as different accounts), so
  // an account that merely exists proves nothing: the key is the evidence that the right network was selected.
  const matchesKey = (key: MirrorAccount["key"]) =>
    !!key &&
    (key.type === "ED25519" || key.type === "ECDSA_SECP256K1") &&
    !!keyCandidates?.some(c => c.type === key.type && c.publicKey === key.key);

  let keyVerified = false;
  if (keyCandidates && account.key) {
    if (account.key.type === "ED25519" || account.key.type === "ECDSA_SECP256K1") {
      keyVerified = matchesKey(account.key);
      if (!keyVerified) {
        let controlledOn: HederaNetworkName | undefined;
        for (const candidate of crossCheckTargets(networkName, options)) {
          const elsewhere = await lookupAccount(
            fetchImpl,
            NETWORKS[candidate].mirrorNodeUrl,
            validAccountId,
            timeoutMs,
          );
          if (elsewhere.kind === "found" && matchesKey(elsewhere.account.key)) {
            controlledOn = candidate;
            break;
          }
        }
        issues.push(
          controlledOn
            ? issue(
                "NETWORK_MISMATCH",
                "network",
                `${ENV.OPERATOR_KEY} controls account ${validAccountId} on ${controlledOn}, but ${ENV.NETWORK} is ${networkName}, where ${validAccountId} is a different account.`,
                `Set ${ENV.NETWORK}=${controlledOn} to use this account, or use an account and key created on ${networkName}.`,
                { variable: ENV.NETWORK, details: { configuredNetwork: networkName, foundOn: controlledOn } },
              )
            : issue(
                "KEY_MISMATCH",
                "key",
                `${ENV.OPERATOR_KEY} does not belong to account ${validAccountId}: its public key differs from the account's key on ${networkName}.`,
                `Use the private key created together with that account, or set ${ENV.OPERATOR_ID} to the account this key controls.`,
                { variable: ENV.OPERATOR_KEY },
              ),
        );
      }
    } else {
      warnings.push(
        issue(
          "KEY_UNVERIFIABLE",
          "key",
          `Account ${validAccountId} uses a multi-key or threshold key, so ${ENV.OPERATOR_KEY} could not be matched to it.`,
          "Make sure the key you configured can sign for this account.",
          { severity: "warning", variable: ENV.OPERATOR_KEY },
        ),
      );
    }
  }

  // 8. Balance -------------------------------------------------------------------------------------------------------
  if (account.balanceTinybars < minBalance) {
    const min = formatHbar(minBalance);
    issues.push(
      issue(
        "INSUFFICIENT_BALANCE",
        "balance",
        `Account ${validAccountId} has ${formatHbar(account.balanceTinybars)} HBAR on ${networkName}; at least ${min} HBAR is required.`,
        networkName === "testnet"
          ? `Get testnet HBAR at ${FAUCET_URL}, wait for it to be credited, then run the command again. Lower ${ENV.MIN_BALANCE_HBAR} only if you know your operations cost less.`
          : `Fund ${validAccountId} with at least ${min} HBAR, then run the command again.`,
        {
          variable: ENV.OPERATOR_ID,
          details: { balanceTinybars: account.balanceTinybars.toString(), minimumTinybars: minBalance.toString() },
        },
      ),
    );
  }

  if (issues.length > 0) return invalid({ network: networkName, accountId: validAccountId });

  return {
    ok: true,
    status: "valid",
    network: networkName,
    accountId: validAccountId,
    balance: toAmount(account.balanceTinybars),
    minimumBalance: toAmount(minBalance),
    hashscanUrl: network.hashscanUrl ? `${network.hashscanUrl}/account/${validAccountId}` : null,
    mirrorNodeOrigin: origin,
    keyVerified,
    keyType: keyVerified && account.key ? (account.key.type as PublicKeyCandidate["type"]) : null,
    warnings,
    checkedAt,
  };
}

/** True when the validation ended for connectivity reasons only and says nothing about the configuration. */
export function isUnverified(result: EnvironmentValidation): result is InvalidEnvironment {
  return !result.ok && result.status === "unverified";
}
