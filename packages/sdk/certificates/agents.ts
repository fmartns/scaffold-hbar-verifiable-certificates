/**
 * Credo agents backed by the Hedera Verifiable Data Registry.
 *
 * Each role has its own Askar wallet, because holder binding only means something when the holder's link secret lives
 * in a wallet nobody else opens: the issuer (writes to Hedera), each holder (keeps credentials and link secret) and the
 * verifier (only reads from Hedera). Every agent resolves DIDs, schemas, credential definitions and revocation state
 * from Hedera through `@credo-ts/hedera` and the Hiero DID SDK.
 */
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnonCredsModule, BasicTailsFileService } from "@credo-ts/anoncreds";
import type { AnonCredsRevocationRegistryDefinition, GetRevocationStatusListReturn } from "@credo-ts/anoncreds";
import { AskarModule } from "@credo-ts/askar";
import { Agent, DidsModule, TypedArrayEncoder } from "@credo-ts/core";
import type { AgentContext } from "@credo-ts/core";
import { HederaDidRegistrar, HederaDidResolver, HederaModule } from "@credo-ts/hedera";
import { HederaAnonCredsRegistry } from "@credo-ts/hedera/anoncreds";
import { agentDependencies } from "@credo-ts/node";
import { NativeAnoncreds } from "@hyperledger/anoncreds-nodejs";
import { NativeAskar } from "@openwallet-foundation/askar-nodejs";
import type { CertificatesConfig } from "./config";

/**
 * Hedera AnonCreds registry with one fix: `@hiero-did-sdk/anoncreds` 0.1.8 returns revocation status lists stamped with
 * the requested time in milliseconds, while AnonCreds timestamps are seconds. anoncreds-rs then refuses every
 * non-revocation proof ("Either timestamp and revocation state must be presented, or neither"). The list content is
 * already the state at that time (entries are filtered by consensus timestamp), so only the unit is corrected.
 */
export class HederaVdrRegistry extends HederaAnonCredsRegistry {
  override async getRevocationStatusList(
    agentContext: AgentContext,
    revocationRegistryId: string,
    timestamp: number,
  ): Promise<GetRevocationStatusListReturn> {
    const result = await super.getRevocationStatusList(agentContext, revocationRegistryId, timestamp);
    if (result.revocationStatusList) result.revocationStatusList = { ...result.revocationStatusList, timestamp };
    return result;
  }
}

/**
 * Standard AnonCreds tails hosting: files are addressed by their hash and served by the app at `/api/tails/<hash>`.
 * Only holders need them (to build non-revocation proofs); verifiers never do. A holder running next to the issuer
 * reads the local copy; any other holder downloads it from the URL in the revocation registry definition.
 */
export class LocalTailsFileService extends BasicTailsFileService {
  constructor(
    private readonly directory: string,
    private readonly publicUrl: string,
  ) {
    super({ tailsDirectoryPath: directory });
  }

  static pathFor(directory: string, tailsHash: string): string {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(tailsHash)) throw new TypeError("Invalid tails hash.");
    return path.join(directory, tailsHash);
  }

  override async uploadTailsFile(
    _agentContext: AgentContext,
    options: { revocationRegistryDefinition: AnonCredsRevocationRegistryDefinition },
  ) {
    const { tailsLocation, tailsHash } = options.revocationRegistryDefinition.value;
    await mkdir(this.directory, { recursive: true });
    await copyFile(tailsLocation, LocalTailsFileService.pathFor(this.directory, tailsHash));
    return { tailsFileUrl: `${this.publicUrl}/api/tails/${tailsHash}` };
  }

  override async getTailsFile(
    agentContext: AgentContext,
    options: { revocationRegistryDefinition: AnonCredsRevocationRegistryDefinition },
  ) {
    const local = LocalTailsFileService.pathFor(this.directory, options.revocationRegistryDefinition.value.tailsHash);
    if (existsSync(local)) return { tailsFilePath: local };
    return super.getTailsFile(agentContext, options);
  }
}

export interface AgentOptions {
  /** In-memory wallet, for tests: nothing is written to `dataDir/wallets`. */
  inMemory?: boolean;
}

/** Wallet key of one agent: 32 random bytes, created on first use and kept next to the wallet (both git-ignored). */
async function walletKey(dataDir: string, label: string): Promise<string> {
  const file = path.join(dataDir, "wallets", `${label}.key`);
  if (existsSync(file)) return (await readFile(file, "utf8")).trim();
  await mkdir(path.dirname(file), { recursive: true });
  const key = TypedArrayEncoder.toBase58(randomBytes(32));
  await writeFile(file, key, { mode: 0o600 });
  return key;
}

/** Opens (creating on first use) the wallet of `label` and returns an initialized agent. */
export async function openAgent(config: CertificatesConfig, label: string, options: AgentOptions = {}): Promise<Agent> {
  if (!/^[a-z0-9-]+$/.test(label)) throw new TypeError("Agent label must be lowercase letters, digits or dashes.");
  const database = options.inMemory
    ? { type: "sqlite" as const, config: { inMemory: true } }
    : { type: "sqlite" as const, config: { path: path.join(config.dataDir, "wallets", `${label}.sqlite`) } };
  const key = options.inMemory ? TypedArrayEncoder.toBase58(randomBytes(32)) : await walletKey(config.dataDir, label);

  const agent = new Agent({
    config: {},
    dependencies: agentDependencies,
    modules: {
      askar: new AskarModule({ askar: NativeAskar, store: { id: label, key, keyDerivationMethod: "raw", database } }),
      anoncreds: new AnonCredsModule({
        anoncreds: NativeAnoncreds,
        registries: [new HederaVdrRegistry()],
        tailsFileService: new LocalTailsFileService(path.join(config.dataDir, "tails"), config.publicUrl),
      }),
      dids: new DidsModule({ resolvers: [new HederaDidResolver()], registrars: [new HederaDidRegistrar()] }),
      hedera: new HederaModule({
        networks: [{ network: config.network, operatorId: config.operatorId, operatorKey: config.operatorKeyDer }],
      }),
    },
  });
  await agent.initialize();
  return agent;
}
