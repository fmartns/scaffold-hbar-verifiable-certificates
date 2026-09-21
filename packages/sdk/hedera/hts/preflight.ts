/**
 * Preconditions of a settlement, checked against Mirror Node BEFORE any transaction is sent, so a doomed operation is
 * never submitted. This is a preventive convenience, never the enforcement (ADR §6.7): Mirror Node lags, and the HTS
 * response codes remain the final word. A failed check never sends anything.
 *
 * Checks, in order: token exists and is usable; the custodian is the treasury; the custodian holds the supply key (mint
 * model); supply headroom (finite supply); beneficiary exists; beneficiary is associated (or can auto-associate), not
 * frozen and has KYC when the token requires it; the pool holds enough (pool model). Allowances are not used by either
 * model of ADR-001, so none is checked (a failing allowance code is still classified, see errors.ts).
 */
import type { PublicKeyCandidate } from "../environment";
import type { HtsAdapterConfig } from "./config";
import { classifyHtsStatus } from "./errors";
import type { HtsErrorCode, HtsFailure } from "./errors";
import type { AccountInfo, HtsMirror, TokenInfo, TokenRelationship } from "./mirror";
import type { NormalizedSettlement } from "./settlement";

export interface HtsPreflightCheck {
  id: string;
  ok: boolean;
  severity: "error" | "warning" | "info";
  code?: HtsErrorCode;
  message: string;
}

export interface HtsPreflightResult {
  ok: boolean;
  checks: HtsPreflightCheck[];
  /** The first failed check as a normalized failure (`outcome: "not_sent"`). */
  failure?: HtsFailure;
  /** The account that pays out / holds the pool: the router contract, or the configured treasury. */
  treasuryId?: string;
  beneficiaryAccountId?: string;
  token?: TokenInfo;
  /** How the beneficiary can receive the token. */
  association?: "associated" | "auto_association_possible" | "not_associated";
}

export interface HtsPreflightContext {
  config: HtsAdapterConfig;
  mirror: HtsMirror;
  settlement: NormalizedSettlement;
  /** Public keys the operator signs with, to verify supply-key ownership under operator custody. */
  operatorKeys?: PublicKeyCandidate[];
  /** The mint of this settlement is already applied (resuming): skip the mint-permission and supply checks. */
  skipMint?: boolean;
  /** Check only the token and the custody setup (no beneficiary, no pool balance): for startup/setup validation. */
  tokenOnly?: boolean;
}

/**
 * Decodes a Mirror `ProtobufEncoded` key that is a contract-id key (`contractID`, field 1, or `delegatableContractId`,
 * field 8) into `0.0.x`. Returns null for anything else (key lists, threshold keys, malformed input).
 * Observed on Testnet: token 0.0.10589073 has admin key `42051890a78605` = delegatable contract 0.0.10589072.
 */
export function decodeContractIdKey(hex: string): string | null {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  let pos = 0;
  const varint = (): bigint | null => {
    let result = 0n;
    for (let shift = 0n; pos < bytes.length && shift < 70n; shift += 7n) {
      const byte = bytes[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
    }
    return null;
  };
  const tag = varint();
  if (tag === null || (tag >> 3n !== 1n && tag >> 3n !== 8n) || (tag & 7n) !== 2n) return null;
  const length = varint();
  if (length === null || pos + Number(length) !== bytes.length) return null;
  const parts = { 1: 0n, 2: 0n, 3: 0n } as Record<number, bigint>;
  while (pos < bytes.length) {
    const inner = varint();
    if (inner === null || (inner & 7n) !== 0n) return null;
    const field = Number(inner >> 3n);
    const value = varint();
    if (value === null || !(field in parts)) return null;
    parts[field] = value;
  }
  return `${parts[1]}.${parts[2]}.${parts[3]}`;
}

const NOT_SENT = { outcome: "not_sent" as const, operation: "preflight" as const };

/** A failure for a check, with the message of the equivalent Hedera status but as a preflight (nothing sent). */
function fromStatus(status: string, ctx: { tokenId?: string; accountId?: string; amount?: string }): HtsFailure {
  const failure = classifyHtsStatus(status, { operation: "preflight", ...ctx });
  delete failure.hederaStatus; // nothing reached the network, so there is no network status to report
  return { ...failure, ...NOT_SENT };
}

export async function runHtsPreflight(ctx: HtsPreflightContext): Promise<HtsPreflightResult> {
  const { config, mirror, settlement } = ctx;
  const checks: HtsPreflightCheck[] = [];
  const result: HtsPreflightResult = { ok: false, checks };
  const amount = settlement.amount.toString();
  const base = { tokenId: settlement.tokenId, amount };

  const add = (check: HtsPreflightCheck, failure?: HtsFailure) => {
    checks.push(check);
    if (!check.ok && check.severity === "error" && !result.failure) {
      result.failure = { ...(failure as HtsFailure), checks };
    }
    return check.ok;
  };
  const pass = (id: string, message: string, severity: "info" | "warning" = "info") =>
    add({ id, ok: true, severity, message });
  const fail = (id: string, code: HtsErrorCode, message: string, failure: HtsFailure) =>
    add({ id, ok: false, severity: "error", code, message }, failure);

  // 1. token exists on this network
  const token = await mirror.getToken(settlement.tokenId);
  if (!token) {
    fail("token-exists", "TOKEN_NOT_FOUND", `Token ${settlement.tokenId} does not exist on ${config.network.name}.`, {
      ...fromStatus("INVALID_TOKEN_ID", base),
      message: `Token ${settlement.tokenId} does not exist on ${config.network.name}.`,
    });
    return result;
  }
  result.token = token;
  pass("token-exists", `Token ${token.tokenId} (${token.symbol || "no symbol"}) exists on ${config.network.name}.`);

  // 2. token usable
  if (token.type !== "FUNGIBLE_COMMON") {
    fail("token-usable", "TOKEN_INVALID", `Token ${token.tokenId} is ${token.type}, not a fungible token.`, {
      ...fromStatus("TOKEN_WAS_DELETED", base),
      code: "TOKEN_INVALID",
      message: `Token ${token.tokenId} is ${token.type}; settlement credits are fungible (FUNGIBLE_COMMON).`,
      remediation: "Use a fungible HTS token in HEDERA_HTS_TOKEN_ID.",
    });
  } else if (token.deleted) {
    fail("token-usable", "TOKEN_INVALID", `Token ${token.tokenId} was deleted.`, fromStatus("TOKEN_WAS_DELETED", base));
  } else if (token.paused) {
    fail("token-usable", "TOKEN_PAUSED", `Token ${token.tokenId} is paused.`, fromStatus("TOKEN_IS_PAUSED", base));
  } else {
    pass("token-usable", `Token ${token.tokenId} is a fungible token that is active.`);
  }

  // 3. who is the custodian
  let treasuryId = config.treasuryId;
  let routerContractId: string | null = null;
  if (config.custody === "router") {
    routerContractId = config.routerAddress ? await mirror.getContractId(config.routerAddress) : null;
    if (!routerContractId) {
      fail(
        "custody-treasury",
        "CONFIG_INVALID",
        `No contract exists at ${config.routerAddress} on ${config.network.name}.`,
        {
          code: "CONFIG_INVALID",
          ...NOT_SENT,
          message: `No SettlementRouter is deployed at ${config.routerAddress} on ${config.network.name}.`,
          remediation:
            "Deploy the router (#9) on this network and set HEDERA_SETTLEMENT_ROUTER_ADDRESS to its address.",
          retryable: false,
        },
      );
      return result;
    }
    treasuryId = routerContractId;
  }
  result.treasuryId = treasuryId;
  if (token.treasuryAccountId !== treasuryId) {
    fail(
      "custody-treasury",
      "CONFIG_INVALID",
      `The treasury of token ${token.tokenId} is ${token.treasuryAccountId}, not ${treasuryId}.`,
      {
        code: "CONFIG_INVALID",
        ...NOT_SENT,
        message: `The treasury of token ${token.tokenId} is ${token.treasuryAccountId}, but ${config.custody} custody expects ${treasuryId}.`,
        remediation:
          config.custody === "router"
            ? "Create the token with the SettlementRouter as treasury (ADR §6.7), or point HEDERA_HTS_TOKEN_ID at that token."
            : "Use a token whose treasury is the operator (or set HEDERA_HTS_TREASURY_ID).",
        retryable: false,
        tokenId: token.tokenId,
      },
    );
  } else {
    pass("custody-treasury", `The treasury of the token is ${treasuryId} (${config.custody} custody).`);
  }

  // 4. mint permission: the custodian must hold the supply key
  if (config.model === "mint-transfer" && !ctx.skipMint) {
    const supplyKey = token.supplyKey;
    if (!supplyKey) {
      fail(
        "mint-permission",
        "NO_MINT_PERMISSION",
        `Token ${token.tokenId} has no supply key.`,
        fromStatus("TOKEN_HAS_NO_SUPPLY_KEY", base),
      );
    } else if (config.custody === "router") {
      const holder = supplyKey.type === "ProtobufEncoded" ? decodeContractIdKey(supplyKey.key) : null;
      if (holder === routerContractId) {
        pass("mint-permission", `The supply key is the SettlementRouter (${routerContractId}).`);
      } else {
        fail(
          "mint-permission",
          "NO_MINT_PERMISSION",
          `The supply key of token ${token.tokenId} is not the SettlementRouter.`,
          {
            ...fromStatus("INVALID_SUPPLY_KEY", base),
            message: `The supply key of token ${token.tokenId} is ${holder ? `contract ${holder}` : `a ${supplyKey.type} key`}, not the SettlementRouter ${routerContractId}, so the router cannot mint.`,
            remediation:
              "Create the token with the router's contract id as its supply key (ADR §6.7), or use the pool-transfer model.",
          },
        );
      }
    } else if (supplyKey.type === "ProtobufEncoded") {
      pass(
        "mint-permission",
        "The supply key is a complex key; ownership by the operator cannot be confirmed here.",
        "warning",
      );
    } else if ((ctx.operatorKeys ?? []).some(k => k.publicKey.toLowerCase() === supplyKey.key)) {
      pass("mint-permission", "The supply key is the operator key.");
    } else {
      fail("mint-permission", "NO_MINT_PERMISSION", "The operator key is not the supply key of the token.", {
        ...fromStatus("INVALID_SUPPLY_KEY", base),
        message: `The operator key is not the supply key of token ${token.tokenId}, so the operator cannot mint.`,
        remediation:
          "Use a token created with the operator as supply key (operator custody is for development), or the pool-transfer model.",
      });
    }

    // 5. supply headroom
    if (token.supplyType === "FINITE") {
      const headroom = token.maxSupply - token.totalSupply;
      if (headroom < settlement.amount) {
        fail("supply-headroom", "SUPPLY_EXCEEDED", `Only ${headroom} can still be minted.`, {
          ...fromStatus("TOKEN_MAX_SUPPLY_REACHED", base),
          message: `Only ${headroom} of token ${token.tokenId} can still be minted before its maximum supply, and ${amount} is requested.`,
        });
      } else {
        pass("supply-headroom", `${headroom} can still be minted; ${amount} is requested.`);
      }
    }
  }

  if (ctx.tokenOnly) {
    result.ok = !checks.some(c => !c.ok && c.severity === "error");
    return result;
  }

  // 6. beneficiary exists
  const account: AccountInfo | null = await mirror.getAccount(settlement.beneficiary);
  if (!account || account.deleted) {
    fail(
      "beneficiary-exists",
      "ACCOUNT_NOT_FOUND",
      `Beneficiary ${settlement.beneficiary} does not exist or was deleted.`,
      {
        ...fromStatus("INVALID_ACCOUNT_ID", { ...base, accountId: settlement.beneficiary }),
        message: `Beneficiary ${settlement.beneficiary} does not exist on ${config.network.name} or was deleted.`,
      },
    );
    return result;
  }
  result.beneficiaryAccountId = account.accountId;
  if (account.accountId === treasuryId) {
    fail("beneficiary-exists", "INVALID_SETTLEMENT", "The beneficiary is the treasury itself.", {
      code: "INVALID_SETTLEMENT",
      ...NOT_SENT,
      message: `The beneficiary ${account.accountId} is the token treasury, so there is nothing to transfer.`,
      remediation: "Settle to a different account.",
      retryable: false,
      accountId: account.accountId,
    });
    return result;
  }
  pass("beneficiary-exists", `Beneficiary ${account.accountId} exists on ${config.network.name}.`);

  // 7. association, freeze and KYC
  const relationship: TokenRelationship | null = await mirror.getRelationship(account.accountId, settlement.tokenId);
  const accountCtx = { ...base, accountId: account.accountId };
  if (!relationship) {
    if (account.maxAutomaticTokenAssociations !== 0) {
      result.association = "auto_association_possible";
      pass(
        "beneficiary-associated",
        `${account.accountId} is not associated yet, but it allows automatic association, so the transfer can associate it.`,
        "warning",
      );
    } else {
      result.association = "not_associated";
      fail(
        "beneficiary-associated",
        "NOT_ASSOCIATED",
        `${account.accountId} is not associated with token ${settlement.tokenId}.`,
        fromStatus("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", accountCtx),
      );
    }
  } else {
    result.association = "associated";
    if (relationship.freezeStatus === "FROZEN") {
      fail(
        "beneficiary-associated",
        "ACCOUNT_FROZEN",
        `${account.accountId} is frozen for the token.`,
        fromStatus("ACCOUNT_FROZEN_FOR_TOKEN", accountCtx),
      );
    } else if (token.kycKey && relationship.kycStatus !== "GRANTED") {
      fail(
        "beneficiary-associated",
        "KYC_NOT_GRANTED",
        `${account.accountId} has no KYC for the token.`,
        fromStatus("ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN", accountCtx),
      );
    } else {
      pass("beneficiary-associated", `${account.accountId} is associated with the token and can receive it.`);
    }
  }

  // 8. the pool must hold enough (pool model)
  if (config.model === "pool-transfer" && treasuryId) {
    const pool = await mirror.getRelationship(treasuryId, settlement.tokenId);
    const balance = pool?.balance ?? 0n;
    if (balance < settlement.amount) {
      fail("pool-balance", "INSUFFICIENT_BALANCE", `The pool ${treasuryId} holds ${balance}; ${amount} is needed.`, {
        ...fromStatus("INSUFFICIENT_TOKEN_BALANCE", { ...base, accountId: treasuryId }),
        message: `The pool ${treasuryId} holds ${balance} of token ${settlement.tokenId}, but ${amount} is needed.`,
      });
    } else {
      pass("pool-balance", `The pool ${treasuryId} holds ${balance}; ${amount} is needed.`);
    }
  }

  result.ok = !checks.some(c => !c.ok && c.severity === "error");
  return result;
}
