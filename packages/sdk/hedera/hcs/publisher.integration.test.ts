/**
 * OPTIONAL integration test against the real Hedera Testnet. Skipped unless explicitly enabled:
 *
 *     HCS_INTEGRATION=1 yarn workspace @sh/sdk test:integration
 *
 * It publishes ONE real message per run (a few tinybars of testnet HBAR). Credentials and the topic come from the
 * environment (or the repository's root `.env`); nothing is hardcoded and nothing secret is printed:
 *
 *     HEDERA_NETWORK=testnet   HEDERA_OPERATOR_ID=0.0.x   HEDERA_OPERATOR_KEY=...
 *     HEDERA_HCS_TOPIC_ID=0.0.y            (a topic whose submitKey is the operator key)
 *     HEDERA_SETTLEMENT_ROUTER_ADDRESS     (optional here: a placeholder router is used when unset)
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeMessage } from "./envelope";
import { createHcsPublisherFromEnv } from "./hiero-transport";
import { preflightHcsPublisher } from "./topic-check";
import { TEST_ROUTER, TEST_SIGNER, b32, makeEvent, signEvent } from "./test-fixtures";

const enabled = process.env.HCS_INTEGRATION === "1";

function integrationEnv(): Record<string, string | undefined> {
  const rootEnv = resolve(__dirname, "../../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv); // never overrides variables that are already set
  return { HEDERA_SETTLEMENT_ROUTER_ADDRESS: TEST_ROUTER, ...process.env, HEDERA_NETWORK: "testnet" };
}

async function mirrorMessage(mirrorUrl: string, topicId: string, sequence: string): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${mirrorUrl}/api/v1/topics/${topicId}/messages/${sequence}`);
    if (response.ok) {
      const body = (await response.json()) as { message: string };
      return Uint8Array.from(Buffer.from(body.message, "base64"));
    }
    await new Promise(resolve => setTimeout(resolve, 1_500)); // Mirror Node is eventually consistent (ADR §3.8)
  }
  throw new Error(`Mirror Node did not index ${topicId}#${sequence} in time`);
}

describe.skipIf(!enabled)("HCS publisher on Hedera Testnet (real network)", () => {
  it("publishes a settlement attestation and returns a valid transaction id and HashScan link", async () => {
    const env = integrationEnv();
    const preflight = await preflightHcsPublisher(env);
    if (!preflight.ok) throw new Error(`Preflight failed: ${preflight.error.message} ${preflight.error.remediation}`);

    const { publisher, close } = await createHcsPublisherFromEnv(env);
    try {
      const event = makeEvent({
        // A new identity per run, so repeated runs never look like duplicates of each other.
        externalEventId: b32(`integration-test:${Date.now()}`),
        observedAt: BigInt(Math.floor(Date.now() / 1000)),
        validUntil: BigInt(Math.floor(Date.now() / 1000) + 600),
      });
      const signature = await signEvent(event, env.HEDERA_SETTLEMENT_ROUTER_ADDRESS);
      const result = await publisher.publish({ event, signature });

      expect(result, result.ok ? "" : JSON.stringify(result.error)).toMatchObject({ ok: true, status: "published" });
      if (!result.ok) return;

      expect(result.transactionId).toMatch(/^0\.0\.\d+@\d+\.\d+$/);
      expect(result.mirrorTransactionId).toMatch(/^0\.0\.\d+-\d+-\d+$/);
      expect(result.topicId).toBe(env.HEDERA_HCS_TOPIC_ID);
      expect(result.hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/\d+\.\d{9}$/);
      expect(result.hcsRef.sequence).toMatch(/^[1-9]\d*$/);
      // Printed for the person running the test; contains no secret.
      console.info(`HCS integration: ${result.hashscanUrl}`);

      // The message that reached the topic decodes, with the shared envelope code, to the attestation we sent.
      const fetched = await mirrorMessage(
        preflight.config.network.mirrorNodeUrl,
        result.topicId,
        result.hcsRef.sequence,
      );
      const decoded = decodeMessage(fetched, {
        chainId: 296,
        verifyingContract: env.HEDERA_SETTLEMENT_ROUTER_ADDRESS as string,
      });
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.value.derived.attestationDigest).toBe(result.event.attestationDigest);
        expect(decoded.value.derived.signer).toBe(TEST_SIGNER.address.toLowerCase());
      }
    } finally {
      close();
    }
  }, 90_000);

  it("reports a nonexistent topic as TOPIC_INVALID without throwing", async () => {
    const env: Record<string, string | undefined> = { ...integrationEnv(), HEDERA_HCS_TOPIC_ID: "0.0.999999999" };
    const { publisher, close } = await createHcsPublisherFromEnv(env);
    try {
      const event = makeEvent({ externalEventId: b32(`integration-test-bad-topic:${Date.now()}`) });
      const result = await publisher.publish({
        event,
        signature: await signEvent(event, env.HEDERA_SETTLEMENT_ROUTER_ADDRESS),
      });
      expect(result).toMatchObject({ ok: false, error: { code: "TOPIC_INVALID", outcome: "rejected" } });
    } finally {
      close();
    }
  }, 90_000);
});
