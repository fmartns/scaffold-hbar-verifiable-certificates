import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHedera } from "../testing/hedera";
import { HCS1_CHUNK_SIZE, decodeHcs1, encodeHcs1, sha256Hex } from "./hcs1";
import { fetchHcs1File } from "./ledger";

// Random bytes do not compress, so this spans several 960-character chunks.
const file = randomBytes(4000);

describe("HCS-1 codec", () => {
  it("round-trips bytes and MIME type through memo and chunk messages", () => {
    const { memo, messages } = encodeHcs1(file, "application/pdf");
    expect(memo).toBe(`${sha256Hex(file)}:zstd:base64`);
    expect(messages.length).toBeGreaterThan(5);
    expect(messages.every(message => JSON.parse(message).c.length <= HCS1_CHUNK_SIZE)).toBe(true);
    expect(JSON.parse(messages[0]).c.startsWith("data:application/pdf;base64,")).toBe(true);

    const decoded = decodeHcs1(memo, [...messages].reverse());
    expect(Buffer.from(decoded.bytes).equals(file)).toBe(true);
    expect(decoded).toMatchObject({ mimeType: "application/pdf", sha256: sha256Hex(file) });
  });

  it("rejects a missing, duplicated or malformed chunk", () => {
    const { memo, messages } = encodeHcs1(file, "application/pdf");
    expect(() => decodeHcs1(memo, messages.slice(1))).toThrow(/chunk 0 is missing/);
    expect(() => decodeHcs1(memo, [...messages, messages[1]])).toThrow(/appears twice/);
    expect(() => decodeHcs1(memo, [...messages.slice(0, -1), "not json"])).toThrow(/not JSON/);
    expect(() => decodeHcs1(memo, [...messages.slice(0, -1), '{"o":"x","c":1}'])).toThrow(/integer/);
  });

  it("rejects content that does not match the memo hash", () => {
    const { messages } = encodeHcs1(file, "application/pdf");
    const otherMemo = `${sha256Hex(Buffer.from("something else"))}:zstd:base64`;
    expect(() => decodeHcs1(otherMemo, messages)).toThrow(/does not match the hash/);

    const tampered = JSON.parse(messages[2]);
    tampered.c = `${tampered.c.slice(0, -4)}AAAA`;
    const { memo } = encodeHcs1(file, "application/pdf");
    expect(() => decodeHcs1(memo, [...messages.slice(0, 2), JSON.stringify(tampered), ...messages.slice(3)])).toThrow(
      /zstd|does not match/,
    );
  });

  it("rejects a memo that is not HCS-1 and content without a data URI", () => {
    const { memo } = encodeHcs1(file, "application/pdf");
    expect(() => decodeHcs1("hello", [])).toThrow(/not an HCS-1/);
    expect(() => decodeHcs1(memo, [JSON.stringify({ o: 0, c: "plain text" })])).toThrow(/data URI/);
  });
});

describe("fetchHcs1File (Mirror Node)", () => {
  it("follows pagination and verifies the file", async () => {
    const hedera = new InMemoryHedera();
    const { topicId } = await hedera.publishFile(null, file, "application/pdf");
    const fetched = await fetchHcs1File(hedera.mirrorNodeUrl, topicId, hedera.fetch);
    expect(Buffer.from(fetched.bytes).equals(file)).toBe(true);
  });

  it("reports an unavailable chunk and a tampered chunk as an invalid document", async () => {
    const hedera = new InMemoryHedera();
    const { topicId } = await hedera.publishFile(null, file, "application/pdf");
    hedera.dropLastChunk = true;
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, topicId, hedera.fetch)).rejects.toMatchObject({
      code: "DOCUMENT_INVALID",
    });
    hedera.dropLastChunk = false;
    hedera.tamper(topicId, 1, JSON.stringify({ o: 1, c: "AAAA" }));
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, topicId, hedera.fetch)).rejects.toMatchObject({
      code: "DOCUMENT_INVALID",
    });
  });

  it("refuses topics with an admin key, unknown topics, bad ids and an unreachable Mirror Node", async () => {
    const hedera = new InMemoryHedera();
    const mutable = hedera.createTopic(encodeHcs1(file, "application/pdf").memo, true);
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, mutable, hedera.fetch)).rejects.toThrow(/admin key/);
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, "0.0.424242", hedera.fetch)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, "../x", hedera.fetch)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, "0.0.1", down)).rejects.toMatchObject({
      code: "LEDGER_READ_FAILED",
    });
    const failing = (async () => new Response("", { status: 503 })) as typeof fetch;
    await expect(fetchHcs1File(hedera.mirrorNodeUrl, "0.0.1", failing)).rejects.toThrow(/HTTP 503/);
  });
});
