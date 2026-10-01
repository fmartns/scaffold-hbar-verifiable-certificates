/**
 * The issuer key of `yarn verify:testnet`: the operator's own key, used as an EVM key to sign the credential (EIP-712)
 * and send the registry transactions through the JSON-RPC relay. Only an ECDSA (secp256k1) key has an EVM address, so
 * an ED25519 operator is refused with a fix instead of failing later in the relay. The key is resolved against the
 * account by `resolveKeyForAccount` (the same check the HCS publisher uses) and is never echoed.
 */
import { ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables } from "../environment";
import { resolveKeyForAccount } from "../hcs/hiero-transport";
import type { HieroPrivateKeySdk } from "../hcs/hiero-transport";
import type { HederaNetwork } from "../networks";

export class IssuerKeyError extends Error {
  readonly code: "ISSUER_KEY_UNRESOLVED" | "ISSUER_KEY_NOT_ECDSA";
  readonly remediation: string;
  constructor(code: IssuerKeyError["code"], message: string, remediation: string) {
    super(message);
    this.name = "IssuerKeyError";
    this.code = code;
    this.remediation = remediation;
  }
}

interface ResolvedKey {
  type?: unknown;
  toStringRaw(): string;
}

/** Returns the operator key as a raw 32-byte secp256k1 hex key (`0x…`). Throws {@link IssuerKeyError}. */
export async function resolveOperatorEvmKey(
  env: EnvironmentVariables,
  network: HederaNetwork,
  options: { fetch?: typeof fetch; sdk?: HieroPrivateKeySdk } = {},
): Promise<string> {
  const operatorId = env[HEDERA_ENV.OPERATOR_ID]?.trim() ?? "";
  const sdk = options.sdk ?? ((await import("@hiero-ledger/sdk")) as unknown as HieroPrivateKeySdk);
  let key: ResolvedKey;
  try {
    key = (await resolveKeyForAccount(
      env[HEDERA_ENV.OPERATOR_KEY] ?? "",
      operatorId,
      network,
      sdk,
      options.fetch ?? globalThis.fetch,
      HEDERA_ENV.OPERATOR_KEY,
    )) as ResolvedKey;
  } catch {
    throw new IssuerKeyError(
      "ISSUER_KEY_UNRESOLVED",
      `${HEDERA_ENV.OPERATOR_KEY} could not be matched to ${operatorId || HEDERA_ENV.OPERATOR_ID}.`,
      "Run `yarn setup` to diagnose the operator key.",
    );
  }
  if (!/secp256k1|ecdsa/i.test(String(key.type ?? ""))) {
    throw new IssuerKeyError(
      "ISSUER_KEY_NOT_ECDSA",
      "The operator key is ED25519, which has no EVM address: it cannot sign the credential or send registry transactions.",
      "Use an ECDSA (secp256k1) Testnet account as the operator (the Hedera portal creates one; see docs/testnet-validation.md).",
    );
  }
  return `0x${key.toStringRaw().replace(/^0x/i, "")}`;
}
