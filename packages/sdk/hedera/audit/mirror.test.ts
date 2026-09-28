import { describe, expect, it } from "vitest";
import { createCredentialMirror } from "./mirror";
import { CREDENTIAL_ISSUED_TOPIC } from "./registry";
import {
  CREDENTIAL_ID,
  HCS_ISSUANCE_TS,
  ISSUANCE_SEQUENCE,
  NETWORK,
  REGISTRY,
  TOPIC,
  consistentWorld,
  fakeFetch,
} from "./test-fixtures";

describe("credential Mirror Node client", () => {
  it("fetches one topic message by sequence and decodes base64 fields", async () => {
    const world = await consistentWorld();
    const { fetch, calls } = fakeFetch(world);
    const mirror = createCredentialMirror(NETWORK, { fetch });

    const message = await mirror.getTopicMessage(TOPIC, ISSUANCE_SEQUENCE);
    expect(calls).toEqual([`GET /api/v1/topics/${TOPIC}/messages/5`]);
    expect(message).toMatchObject({ topicId: TOPIC, sequenceNumber: 5n, consensusTimestamp: HCS_ISSUANCE_TS });
    expect(message?.message).toEqual(world.messages[0].bytes);
    expect(message?.runningHash).toBe(`0x${"ab".repeat(48)}`);
    expect(mirror.origin).toBe("https://testnet.mirrornode.hedera.com");
  });

  it("returns null for a message that is not indexed (404), never throws", async () => {
    const { fetch } = fakeFetch(await consistentWorld());
    expect(await createCredentialMirror(NETWORK, { fetch }).getTopicMessage(TOPIC, 999n)).toBeNull();
  });

  it("always sends a timestamp range with topic-filtered log queries (ADR P6)", async () => {
    const { fetch, calls } = fakeFetch(await consistentWorld());
    const logs = await createCredentialMirror(NETWORK, { fetch }).getContractLogs(REGISTRY, {
      topic0: CREDENTIAL_ISSUED_TOPIC,
      topic1: CREDENTIAL_ID,
      from: "1767225590",
      to: "1767225620",
    });
    expect(calls[0]).toBe(
      `GET /api/v1/contracts/${REGISTRY}/results/logs?topic0=${CREDENTIAL_ISSUED_TOPIC}&topic1=${CREDENTIAL_ID}&timestamp=gte:1767225590&timestamp=lte:1767225620&order=asc&limit=100`,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0].topics[1]).toBe(CREDENTIAL_ID);
  });

  it("follows pagination links", async () => {
    const pages: Record<string, unknown> = {
      "/api/v1/topics/0.0.4567/messages": {
        messages: [{ consensus_timestamp: "1.1", message: "AQ==", sequence_number: 1 }],
        links: { next: "/api/v1/topics/0.0.4567/messages?page=2" },
      },
      "/api/v1/topics/0.0.4567/messages?page=2": {
        messages: [{ consensus_timestamp: "2.1", message: "Ag==", sequence_number: 2 }],
        links: { next: null },
      },
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const key = url.searchParams.has("page") ? `${url.pathname}?page=2` : url.pathname;
      return new Response(JSON.stringify(pages[key]), { status: 200 });
    }) as typeof fetch;
    const messages = await createCredentialMirror(NETWORK, { fetch: fetchImpl }).listTopicMessages(TOPIC, {
      from: "0",
      to: "9",
    });
    expect(messages.map(m => m.sequenceNumber)).toEqual([1n, 2n]);
  });

  it("classifies failures: network and 5xx/429 are retryable, 4xx and bad JSON are not", async () => {
    const world = await consistentWorld();
    const mirror = (w: typeof world) => createCredentialMirror(NETWORK, { fetch: fakeFetch(w).fetch });

    await expect(mirror({ ...world, offline: true }).getTopicMessage(TOPIC, 5n)).rejects.toMatchObject({
      code: "MIRROR_UNAVAILABLE",
      retryable: true,
    });
    await expect(mirror({ ...world, failures: { "/topics/": 503 } }).getTopicMessage(TOPIC, 5n)).rejects.toMatchObject({
      retryable: true,
    });
    await expect(mirror({ ...world, failures: { "/topics/": 429 } }).getTopicMessage(TOPIC, 5n)).rejects.toMatchObject({
      retryable: true,
    });
    await expect(mirror({ ...world, failures: { "/topics/": 400 } }).getTopicMessage(TOPIC, 5n)).rejects.toMatchObject({
      retryable: false,
    });
    const badJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(createCredentialMirror(NETWORK, { fetch: badJson }).getTopicMessage(TOPIC, 5n)).rejects.toMatchObject({
      code: "MIRROR_MALFORMED",
    });
  });

  it("never puts more than the Mirror origin in an error message", async () => {
    const network = { ...NETWORK, mirrorNodeUrl: "https://mirror.example.com/secret-path/api-key-123" };
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await createCredentialMirror(network, { fetch: offline })
      .getTopicMessage(TOPIC, 5n)
      .catch(e => e as Error);
    expect(String(error)).toContain("https://mirror.example.com");
    expect(String(error)).not.toContain("api-key-123");
  });

  it("lists CredentialRegistry transactions (contract results)", async () => {
    const world = await consistentWorld();
    world.transactions = [
      {
        hash: `0x${"CD".repeat(32)}`,
        timestamp: "1767225600.200000000",
        from: "0x00000000000000000000000000000000000003E9",
        result: "SUCCESS",
        function_parameters: "0xabcdef01deadbeef",
      },
    ];
    const txs = await createCredentialMirror(NETWORK, { fetch: fakeFetch(world).fetch }).listContractTransactions(
      REGISTRY,
      { from: "0", to: "9999999999" },
    );
    expect(txs).toEqual([
      {
        transactionHash: `0x${"cd".repeat(32)}`,
        consensusTimestamp: "1767225600.200000000",
        from: "0x00000000000000000000000000000000000003e9",
        result: "SUCCESS",
        functionSelector: "0xabcdef01",
      },
    ]);
  });
});
