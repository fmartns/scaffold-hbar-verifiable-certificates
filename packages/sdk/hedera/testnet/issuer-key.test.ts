import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { IssuerKeyError, resolveOperatorEvmKey } from "./issuer-key";

const NETWORK = NETWORKS.testnet;
const ECDSA_RAW = "ab".repeat(32);
const ECDSA = PrivateKey.fromStringECDSA(ECDSA_RAW);
const ED25519 = PrivateKey.fromStringED25519("cd".repeat(32));

/** Mirror Node answering the operator account with the given public key. */
const mirrorWith = (key: { _type: string; key: string }) =>
  (async () => new Response(JSON.stringify({ account: "0.0.1001", key }))) as unknown as typeof fetch;

const env = (key: string) => ({ HEDERA_OPERATOR_ID: "0.0.1001", HEDERA_OPERATOR_KEY: key });

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as IssuerKeyError;
  }
  throw new Error("expected a failure");
};

describe("resolveOperatorEvmKey", () => {
  it("returns the raw secp256k1 key of an ECDSA operator (raw hex disambiguated by the account's key)", async () => {
    const fetchImpl = mirrorWith({ _type: "ECDSA_SECP256K1", key: ECDSA.publicKey.toStringRaw() });
    expect(await resolveOperatorEvmKey(env(`0x${ECDSA_RAW}`), NETWORK, { fetch: fetchImpl })).toBe(`0x${ECDSA_RAW}`);
  });

  it("accepts a DER-encoded ECDSA key", async () => {
    const key = await resolveOperatorEvmKey(env(ECDSA.toStringDer()), NETWORK, {
      fetch: mirrorWith({ _type: "x", key: "y" }),
    });
    expect(key).toBe(`0x${ECDSA_RAW}`);
  });

  it("refuses an ED25519 operator, which has no EVM address", async () => {
    const error = await failure(resolveOperatorEvmKey(env(ED25519.toStringDer()), NETWORK));
    expect(error).toBeInstanceOf(IssuerKeyError);
    expect(error.code).toBe("ISSUER_KEY_NOT_ECDSA");
    expect(error.remediation).toContain("ECDSA");
  });

  it("refuses a key that does not match the account, without echoing it", async () => {
    const fetchImpl = mirrorWith({ _type: "ECDSA_SECP256K1", key: "02" + "00".repeat(32) });
    const error = await failure(resolveOperatorEvmKey(env(ECDSA_RAW), NETWORK, { fetch: fetchImpl }));
    expect(error.code).toBe("ISSUER_KEY_UNRESOLVED");
    expect(`${error.message} ${error.remediation}`).not.toContain(ECDSA_RAW);
    expect((await failure(resolveOperatorEvmKey({}, NETWORK, { fetch: fetchImpl }))).code).toBe(
      "ISSUER_KEY_UNRESOLVED",
    );
  });
});
