import { TypedDataEncoder, concat, getBytes, hexlify, keccak256, toBeHex, toUtf8Bytes, zeroPadValue } from "ethers";
import { describe, expect, it } from "vitest";
import {
  CONTENT_TYPEHASH,
  EVENT_KEY_TAG,
  HCS_MAX_MESSAGE_BYTES,
  MAX_DATA_LEN,
  SETTLEMENT_EVENT_TYPES,
  SETTLEMENT_EVENT_TYPE_STRING,
  SETTLEMENT_TAG,
  buildEnvelope,
  computeEventKey,
  decodeMessage,
  encodeMessage,
  messageSha256,
  messageSize,
  validateSettlementEvent,
  validateSignature,
} from "./envelope";
import { TEST_ROUTER, TEST_SIGNER, b32, makeEvent, signEvent } from "./test-fixtures";

const DOMAIN = { chainId: 296, verifyingContract: TEST_ROUTER };

// Golden vectors: they pin the format. SettlementRouter (#9) and any other reader must reproduce them.
const GOLDEN = {
  signature:
    "0xa13baf384f62a119391784ffb503053482e4eb1d312059f707fc94a37d890fbe1ef07a0d9580521ae41f22fe4e0531151bbe3aa327db631d72c9a293649581af1c",
  eventKey: "0xa443f61dfefa9b88087f5580a4365b62f4ff0f44b0cbd672d3323946ed6a27b8",
  settlementId: "0x131e2da33ac18ad10a946d80f3d56cc5a5929d05acf69372fae39fe46a85d9af",
  contentHash: "0x217eb9b439c7478c295d3484ab573bf880892c15d3e5df2cd6bbb0c529bdfa91",
  attestationDigest: "0x6b61fe09abfef4297d0e324de7c510eab9d5b4d6e9021789a34da052b604c905",
  messageSha256: "0xf94367aef65c087723224cb860362ac51deb0d3e76781049f93088602fae2be2",
  messageBytes: 482,
};

async function built(eventOverrides = {}, domain = DOMAIN) {
  const event = makeEvent(eventOverrides);
  const signature = await signEvent(event, domain.verifyingContract, Number(domain.chainId));
  const result = buildEnvelope({ event, signature }, domain);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("envelope constants", () => {
  it("pins the EIP-712 types to the exact type string of ADR §6.1", () => {
    expect(TypedDataEncoder.from(SETTLEMENT_EVENT_TYPES).encodeType("SettlementEvent")).toBe(
      SETTLEMENT_EVENT_TYPE_STRING,
    );
  });

  it("derives the tags from the strings of ADR §4.3", () => {
    expect(EVENT_KEY_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-settlement.event.v1")));
    expect(SETTLEMENT_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-settlement.settlement.v1")));
    expect(CONTENT_TYPEHASH).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps the largest message under the HCS limit without chunking (ADR §6.3)", () => {
    expect(messageSize({ data: `0x${"00".repeat(MAX_DATA_LEN)}` })).toBe(962);
    expect(962).toBeLessThanOrEqual(HCS_MAX_MESSAGE_BYTES);
  });
});

describe("validateSettlementEvent", () => {
  it("normalizes a valid event (numbers and decimal strings become bigint, hex becomes lowercase)", () => {
    const result = validateSettlementEvent({
      ...makeEvent(),
      streamSeq: "0",
      observedAt: 1_767_225_000,
      eventSource: b32("x").toUpperCase().replace("0X", "0x"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.observedAt).toBe(1_767_225_000n);
      expect(result.value.eventSource).toBe(b32("x"));
    }
  });

  it("accepts an ordered stream with a sequence >= 1", () => {
    expect(validateSettlementEvent(makeEvent({ streamId: b32("stream"), streamSeq: 1n })).ok).toBe(true);
  });

  it("reports every problem at once, by field", () => {
    const result = validateSettlementEvent({ version: 2, eventSource: "0x12", streamSeq: -1n, data: "0xabc" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.issues.map(i => i.field);
      expect(fields).toEqual(
        expect.arrayContaining([
          "version",
          "eventSource",
          "externalEventId",
          "policyId",
          "streamSeq",
          "data",
          "submitter",
        ]),
      );
      expect(result.issues.find(i => i.field === "version")?.code).toBe("UNSUPPORTED_VERSION");
    }
  });

  it.each([
    ["eventSource", "ZERO_NOT_ALLOWED"],
    ["externalEventId", "ZERO_NOT_ALLOWED"],
    ["policyId", "ZERO_NOT_ALLOWED"],
  ])("rejects a zero %s", (field, code) => {
    const result = validateSettlementEvent(makeEvent({ [field]: `0x${"00".repeat(32)}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ field, code }));
  });

  it("requires streamSeq 0 for an unordered stream and >= 1 for an ordered one (ADR §4.9)", () => {
    expect(validateSettlementEvent(makeEvent({ streamSeq: 1n })).ok).toBe(false);
    expect(validateSettlementEvent(makeEvent({ streamId: b32("s"), streamSeq: 0n })).ok).toBe(false);
  });

  it("requires validUntil to be later than observedAt", () => {
    expect(validateSettlementEvent(makeEvent({ validUntil: 1_767_225_000n })).ok).toBe(false);
  });

  it("rejects values outside uint64 and unsafe numbers", () => {
    expect(validateSettlementEvent(makeEvent({ observedAt: 1n << 64n })).ok).toBe(false);
    expect(validateSettlementEvent(makeEvent({ observedAt: Number.MAX_SAFE_INTEGER + 1 })).ok).toBe(false);
    expect(validateSettlementEvent(makeEvent({ observedAt: "12.5" })).ok).toBe(false);
  });

  it("enforces MAX_DATA_LEN and hex shape", () => {
    expect(validateSettlementEvent(makeEvent({ data: `0x${"00".repeat(MAX_DATA_LEN)}` })).ok).toBe(true);
    const tooLong = validateSettlementEvent(makeEvent({ data: `0x${"00".repeat(MAX_DATA_LEN + 1)}` }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.issues[0].code).toBe("TOO_LONG");
    expect(validateSettlementEvent(makeEvent({ data: "0xabc" })).ok).toBe(false);
    expect(validateSettlementEvent(makeEvent({ data: "zz" })).ok).toBe(false);
  });

  it("validates the submitter address, including a mixed-case checksum", () => {
    expect(validateSettlementEvent(makeEvent({ submitter: "0x1234" })).ok).toBe(false);
    expect(validateSettlementEvent(makeEvent({ submitter: "0x5FbDB2315678afecb367f032d93F642f64180aa3" })).ok).toBe(
      true,
    );
    expect(validateSettlementEvent(makeEvent({ submitter: "0x5FBDB2315678afecb367f032d93F642f64180aa3" })).ok).toBe(
      false,
    );
  });

  it("rejects a non-object", () => {
    expect(validateSettlementEvent(null).ok).toBe(false);
    expect(validateSettlementEvent("event").ok).toBe(false);
  });
});

describe("validateSignature", () => {
  const good = GOLDEN.signature;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  it("accepts a 65-byte low-s signature", () => {
    expect(validateSignature(good)).toEqual({ ok: true, value: good });
  });

  it("rejects wrong length, bad recovery id and a zero s", () => {
    expect(validateSignature("0x1234").ok).toBe(false);
    expect(validateSignature(undefined).ok).toBe(false);
    expect(validateSignature(`${good.slice(0, -2)}01`).ok).toBe(false);
    expect(validateSignature(concat([getBytes(good).slice(0, 32), new Uint8Array(32), new Uint8Array([27])])).ok).toBe(
      false,
    );
  });

  it("rejects the malleable twin of a signature (high s)", () => {
    const bytes = getBytes(good);
    const s = BigInt(hexlify(bytes.slice(32, 64)));
    const high = concat([
      bytes.slice(0, 32),
      zeroPadValue(toBeHex(N - s), 32),
      new Uint8Array([bytes[64] === 27 ? 28 : 27]),
    ]);
    const result = validateSignature(high);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("MALLEABLE_SIGNATURE");
  });
});

describe("identifiers (ADR §4.3)", () => {
  it("reproduces the golden vectors", async () => {
    const envelope = await built();
    expect(envelope.signature).toBe(GOLDEN.signature);
    expect(envelope.derived).toEqual({
      eventKey: GOLDEN.eventKey,
      settlementId: GOLDEN.settlementId,
      contentHash: GOLDEN.contentHash,
      attestationDigest: GOLDEN.attestationDigest,
      signer: TEST_SIGNER.address.toLowerCase(),
    });
  });

  it("computes eventKey and settlementId as abi.encode of static words (independent check)", async () => {
    const envelope = await built();
    // abi.encode of static types is plain concatenation of 32-byte words.
    expect(envelope.derived.eventKey).toBe(
      keccak256(concat([EVENT_KEY_TAG, envelope.event.eventSource, envelope.event.externalEventId])),
    );
    expect(envelope.derived.settlementId).toBe(
      keccak256(
        concat([
          SETTLEMENT_TAG,
          zeroPadValue(toBeHex(296), 32),
          zeroPadValue(TEST_ROUTER, 32),
          envelope.derived.eventKey,
        ]),
      ),
    );
  });

  it("keeps eventKey stable across a re-attestation while the digest changes and the content hash does not (replay classes C)", async () => {
    const first = await built();
    const second = await built({ observedAt: 1_767_225_100n, validUntil: 1_767_225_700n });
    expect(second.derived.eventKey).toBe(first.derived.eventKey);
    expect(second.derived.contentHash).toBe(first.derived.contentHash);
    expect(second.derived.attestationDigest).not.toBe(first.derived.attestationDigest);
  });

  it("changes the content hash when the facts change (replay class D)", async () => {
    const first = await built();
    const other = await built({ data: "0x00000000000000000000000000000000000000000000000000000000000f4241" });
    expect(other.derived.eventKey).toBe(first.derived.eventKey);
    expect(other.derived.contentHash).not.toBe(first.derived.contentHash);
  });

  it("binds settlementId and digest to the router and chain, but not eventKey (replay class E)", async () => {
    const first = await built();
    const otherRouter = "0x00000000000000000000000000000000000000aa";
    const elsewhere = await built({}, { chainId: 296, verifyingContract: otherRouter });
    const otherChain = await built({}, { chainId: 295, verifyingContract: TEST_ROUTER });
    for (const other of [elsewhere, otherChain]) {
      expect(other.derived.eventKey).toBe(first.derived.eventKey);
      expect(other.derived.settlementId).not.toBe(first.derived.settlementId);
      expect(other.derived.attestationDigest).not.toBe(first.derived.attestationDigest);
    }
  });

  it("separates sources: the same external id under two sources gives two keys", () => {
    const id = b32("order-1");
    expect(computeEventKey(b32("source-a"), id)).not.toBe(computeEventKey(b32("source-b"), id));
  });
});

describe("buildEnvelope", () => {
  it("rejects a signature made for another router: the recovered signer differs from the expected one", async () => {
    const event = makeEvent();
    const signature = await signEvent(event, "0x00000000000000000000000000000000000000aa");
    const result = buildEnvelope({ event, signature }, DOMAIN, { expectedSigner: TEST_SIGNER.address });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0].code).toBe("SIGNER_MISMATCH");
  });

  it("accepts the expected signer regardless of case", async () => {
    const event = makeEvent();
    const signature = await signEvent(event);
    expect(
      buildEnvelope({ event, signature }, DOMAIN, {
        expectedSigner: TEST_SIGNER.address.toUpperCase().replace("0X", "0x"),
      }).ok,
    ).toBe(true);
  });

  it("collects event, signature and domain problems together", () => {
    const result = buildEnvelope(
      { event: makeEvent({ version: 9 }), signature: "0x00" },
      { chainId: 0, verifyingContract: "0x0" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(new Set(result.issues.map(i => i.field))).toEqual(new Set(["version", "signature", "domain"]));
  });

  it("rejects the zero router address", async () => {
    const event = makeEvent();
    const result = buildEnvelope(
      { event, signature: await signEvent(event) },
      { chainId: 296, verifyingContract: "0x0000000000000000000000000000000000000000" },
    );
    expect(result.ok).toBe(false);
  });

  it("is deterministic: loose input and canonical input give identical bytes", async () => {
    const event = makeEvent();
    const signature = await signEvent(event);
    const canonical = buildEnvelope({ event, signature }, DOMAIN);
    const loose = buildEnvelope(
      {
        event: {
          ...event,
          streamSeq: "0",
          observedAt: 1_767_225_000,
          validUntil: "1767225600",
          eventSource: event.eventSource.toUpperCase().replace("0X", "0x"),
        },
        signature: signature.toUpperCase().replace("0X", "0x"),
      },
      DOMAIN,
    );
    expect(canonical.ok && loose.ok).toBe(true);
    if (canonical.ok && loose.ok) {
      expect(hexlify(encodeMessage(loose.value))).toBe(hexlify(encodeMessage(canonical.value)));
      expect(loose.value.derived).toEqual(canonical.value.derived);
    }
  });
});

describe("serialization", () => {
  it("lays the message out as 0x01 || abi.encode(event) || signature", async () => {
    const envelope = await built();
    const message = encodeMessage(envelope);
    expect(message[0]).toBe(1);
    expect(hexlify(message.slice(-65))).toBe(GOLDEN.signature);
    // abi.encode of a struct with a dynamic member starts with the offset 0x20.
    expect(hexlify(message.slice(1, 33))).toBe(zeroPadValue("0x20", 32));
    expect(message.length).toBe(GOLDEN.messageBytes);
    expect(message.length).toBe(messageSize(envelope.event));
    expect(messageSha256(message)).toBe(GOLDEN.messageSha256);
  });

  it("produces byte-identical output on every call", async () => {
    const envelope = await built();
    expect(hexlify(encodeMessage(envelope))).toBe(hexlify(encodeMessage(envelope)));
  });

  it("sizes the largest allowed message at 962 bytes", async () => {
    const envelope = await built({ data: `0x${"ab".repeat(MAX_DATA_LEN)}` });
    expect(encodeMessage(envelope).length).toBe(962);
  });

  it("round-trips through decodeMessage (what #10 does with a Mirror message)", async () => {
    const envelope = await built({ streamId: b32("stream-1"), streamSeq: 7n });
    const decoded = decodeMessage(encodeMessage(envelope), DOMAIN);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(envelope);
  });

  it("decodeMessage rejects an unknown format version, truncation, trailing bytes and a tampered signature", async () => {
    const message = encodeMessage(await built());
    const withByte = (i: number, v: number) => {
      const copy = message.slice();
      copy[i] = v;
      return copy;
    };
    const unsupported = decodeMessage(withByte(0, 2), DOMAIN);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.issues[0].code).toBe("UNSUPPORTED_VERSION");
    expect(decodeMessage(message.slice(0, 40), DOMAIN).ok).toBe(false);
    expect(decodeMessage(message.slice(0, -1), DOMAIN).ok).toBe(false);
    // An extra byte between the ABI body and the signature is not canonical.
    const padded = concat([message.slice(0, -65), new Uint8Array([0]), message.slice(-65)]);
    expect(decodeMessage(getBytes(padded), DOMAIN).ok).toBe(false);
    // A flipped signature bit recovers a different signer, which the expected signer catches.
    const tampered = decodeMessage(withByte(message.length - 10, message[message.length - 10] ^ 1), DOMAIN, {
      expectedSigner: TEST_SIGNER.address,
    });
    expect(tampered.ok).toBe(false);
  });
});
