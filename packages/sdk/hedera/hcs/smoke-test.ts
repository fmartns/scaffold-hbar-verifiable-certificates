/**
 * Quick publish-and-read check of the evidence topic (`yarn hcs:topic --smoke-test`).
 *
 * It publishes ONE real message through the same publisher the system uses, then reads it back from Mirror Node and
 * decodes it with the shared envelope code, proving the whole path works: sign, publish, consensus, index, decode.
 *
 * The message is a throwaway attestation: source `hedera-verifiable-settlement.smoke-test`, signed by a random key that
 * exists only for this call, bound to the configured router (or a placeholder while there is none). No router accepts that
 * source, so it can never settle anything. It stays in the topic permanently, which is why this is opt-in.
 * Pure: injectable `fetch`, transport, signer, clock and sleep; no console, no files.
 */
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { getSelectedNetwork } from "../networks";
import type { EnvironmentVariables } from "../environment";
import { HCS_ENV } from "./config";
import { fetchChargedFee, fetchUsdPerHbar } from "./cost";
import type { ChargedFee } from "./cost";
import { SETTLEMENT_EVENT_TYPES, decodeMessage, eip712Domain } from "./envelope";
import type { SettlementEvent } from "./envelope";
import { HcsPublishError } from "./errors";
import type { HcsPublishFailure } from "./errors";
import { createHcsPublisherFromEnv } from "./hiero-transport";
import type { HcsTransport, PublishSuccess } from "./publisher";

export const SMOKE_TEST_SOURCE = keccak256(toUtf8Bytes("hedera-verifiable-settlement.smoke-test"));
export const SMOKE_TEST_POLICY = keccak256(toUtf8Bytes("hedera-verifiable-settlement.smoke-test.policy"));
/** Used only while no SettlementRouter is configured; the message is then bound to nothing real. */
export const SMOKE_TEST_ROUTER_PLACEHOLDER = "0x000000000000000000000000000000000000dead";

export interface SmokeTestOptions {
  topicId: string;
  fetch?: typeof fetch;
  /** Overrides the transport (tests). When set, no Hedera client is created. */
  transport?: HcsTransport;
  /** Signs the throwaway attestation. Defaults to a random wallet. */
  signer?: { signTypedData: Wallet["signTypedData"]; address: string };
  /** Milliseconds since the epoch, for timings and event times. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How many times to look for the message on Mirror Node, and the pause between looks. Defaults 12 and 1 500 ms. */
  readAttempts?: number;
  readDelayMs?: number;
}

export interface SmokeTestTimings {
  publishMs: number;
  readMs: number | null;
}

export type SmokeTestResult =
  | {
      ok: true;
      published: PublishSuccess;
      /** True when the router was a placeholder because `HEDERA_SETTLEMENT_ROUTER_ADDRESS` is not set yet. */
      routerIsPlaceholder: boolean;
      timings: SmokeTestTimings & { readMs: number };
      /** What Hedera charged for the message, when Mirror Node already has it. */
      charged: ChargedFee | null;
    }
  | { ok: false; stage: "publish"; error: HcsPublishFailure }
  | { ok: false; stage: "read"; published: PublishSuccess; message: string; timings: SmokeTestTimings };

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function runPublishSmokeTest(
  env: EnvironmentVariables,
  options: SmokeTestOptions,
): Promise<SmokeTestResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const configuredRouter = env[HCS_ENV.ROUTER_ADDRESS]?.trim();
  const routerIsPlaceholder = !configuredRouter;
  const router = configuredRouter || SMOKE_TEST_ROUTER_PLACEHOLDER;
  const testEnv = { ...env, [HCS_ENV.TOPIC_ID]: options.topicId, [HCS_ENV.ROUTER_ADDRESS]: router };

  let handle;
  try {
    handle = await createHcsPublisherFromEnv(testEnv, { fetch: options.fetch, transport: options.transport });
  } catch (error) {
    if (error instanceof HcsPublishError) return { ok: false, stage: "publish", error: error.failure };
    throw error;
  }

  try {
    const network = getSelectedNetwork(testEnv);
    const seconds = BigInt(Math.floor(now() / 1000));
    const event: SettlementEvent = {
      version: 1,
      eventSource: SMOKE_TEST_SOURCE as SettlementEvent["eventSource"],
      externalEventId: keccak256(toUtf8Bytes(`smoke-test:${now()}`)) as SettlementEvent["externalEventId"],
      streamId: `0x${"00".repeat(32)}`,
      streamSeq: 0n,
      observedAt: seconds,
      validUntil: seconds + 900n,
      submitter: "0x0000000000000000000000000000000000000000",
      policyId: SMOKE_TEST_POLICY as SettlementEvent["policyId"],
      data: `0x${Buffer.from("smoke-test").toString("hex")}`,
    };
    const signer = options.signer ?? Wallet.createRandom();
    const domain = { chainId: network.chainId, verifyingContract: router };
    const signature = await signer.signTypedData(eip712Domain(domain), SETTLEMENT_EVENT_TYPES, event);

    const startedAt = now();
    const result = await handle.publisher.publish({ event, signature });
    const publishMs = now() - startedAt;
    if (!result.ok) return { ok: false, stage: "publish", error: result.error };
    const published = result;

    // Read it back by position (direct lookup, ADR §5.3). Mirror Node is eventually consistent: wait for it.
    const readStartedAt = now();
    const attempts = Math.max(1, options.readAttempts ?? 12);
    let message: Uint8Array | null = null;
    for (let attempt = 0; attempt < attempts && !message; attempt++) {
      try {
        const response = await fetchImpl(
          `${network.mirrorNodeUrl}/api/v1/topics/${options.topicId}/messages/${published.hcsRef.sequence}`,
        );
        if (response.ok) {
          const body = (await response.json()) as { message?: string };
          if (typeof body.message === "string") message = Uint8Array.from(Buffer.from(body.message, "base64"));
        }
      } catch {
        // Treated like "not indexed yet": the next attempt (or the final report) covers it.
      }
      if (!message && attempt < attempts - 1) await sleep(options.readDelayMs ?? 1_500);
    }
    const readMs = now() - readStartedAt;
    if (!message) {
      return {
        ok: false,
        stage: "read",
        published,
        message: "The message was published but Mirror Node did not return it in time. It is not lost: check HashScan.",
        timings: { publishMs, readMs },
      };
    }

    const decoded = decodeMessage(message, domain, { expectedSigner: signer.address });
    if (!decoded.ok || decoded.value.derived.attestationDigest !== published.event.attestationDigest) {
      return {
        ok: false,
        stage: "read",
        published,
        message: "Mirror Node returned a message that does not decode to the attestation that was published.",
        timings: { publishMs, readMs },
      };
    }

    const usdPerHbar = await fetchUsdPerHbar(network, fetchImpl);
    const charged = await fetchChargedFee(network, published.mirrorTransactionId, usdPerHbar, fetchImpl);
    return { ok: true, published, routerIsPlaceholder, timings: { publishMs, readMs }, charged };
  } finally {
    handle.close();
  }
}
