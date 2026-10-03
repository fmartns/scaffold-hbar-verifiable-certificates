/**
 * Runtime configuration of the certificate agents, derived from the repository-root `.env`.
 *
 * The operator account is validated by `validateHederaEnvironment` (the template's single environment check). Its
 * result also says which curve the key belongs to, which is what turns a raw 32-byte hex key into an unambiguous DER
 * key for Credo and the Hiero SDK (both read bare hex as ED25519).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { PrivateKey } from "@hashgraph/sdk";
import { validateHederaEnvironment } from "../hedera/environment";
import type { EnvironmentVariables, ValidateEnvironmentOptions } from "../hedera/environment";
import { getNetwork } from "../hedera/networks";
import { CertificateError } from "./errors";

export const CERTIFICATE_ENV = {
  DATA_DIR: "CERTIFICATES_DATA_DIR",
  PUBLIC_URL: "CERTIFICATES_PUBLIC_URL",
} as const;

export interface CertificatesConfig {
  network: "testnet" | "mainnet";
  operatorId: string;
  /** DER-encoded operator private key. Server-side only; never logged or returned by an API. */
  operatorKeyDer: string;
  mirrorNodeUrl: string;
  hashscanUrl: string;
  /** Local state: Askar wallets, issuer identifiers, certificate catalog and tails files. Git-ignored. */
  dataDir: string;
  /** Origin of the app, used for the QR code and the tails file URL. */
  publicUrl: string;
}

/** Walks up from `start` to the directory holding `.yarnrc.yml` (the repository root). */
export function findRepositoryRoot(start = process.cwd()): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".yarnrc.yml"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start);
  }
}

export function toDerKey(rawKey: string, keyType: "ED25519" | "ECDSA_SECP256K1" | null): string {
  const value = rawKey.trim().replace(/^0x/i, "");
  if (value.startsWith("30")) return PrivateKey.fromStringDer(value).toStringDer();
  if (keyType === "ECDSA_SECP256K1") return PrivateKey.fromStringECDSA(value).toStringDer();
  if (keyType === "ED25519") return PrivateKey.fromStringED25519(value).toStringDer();
  throw new CertificateError(
    "INVALID_INPUT",
    "HEDERA_OPERATOR_KEY is a raw hex key whose curve could not be checked against the account. Use the DER form.",
  );
}

export async function loadCertificatesConfig(
  env: EnvironmentVariables,
  options: ValidateEnvironmentOptions = {},
): Promise<CertificatesConfig> {
  const validation = await validateHederaEnvironment(env, options);
  if (!validation.ok) {
    const first = validation.issues[0];
    throw new CertificateError(
      "INVALID_INPUT",
      first ? `${first.message} ${first.remediation}` : "The Hedera environment is not valid. Run `yarn setup`.",
    );
  }
  if (validation.network === "local") {
    throw new CertificateError("INVALID_INPUT", "Certificates need a public network: set HEDERA_NETWORK=testnet.");
  }
  const network = getNetwork(validation.network, env);
  const root = findRepositoryRoot();
  return {
    network: validation.network,
    operatorId: validation.accountId,
    operatorKeyDer: toDerKey(env.HEDERA_OPERATOR_KEY ?? "", validation.keyType),
    mirrorNodeUrl: network.mirrorNodeUrl,
    hashscanUrl: network.hashscanUrl ?? "",
    dataDir: path.resolve(root, env[CERTIFICATE_ENV.DATA_DIR] || ".data"),
    publicUrl: (env[CERTIFICATE_ENV.PUBLIC_URL] || "http://localhost:3000").replace(/\/+$/, ""),
  };
}
