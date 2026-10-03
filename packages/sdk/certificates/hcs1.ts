/**
 * HCS-1 files (https://hol.org/docs/standards/hcs-1): a file stored as the messages of a dedicated HCS topic.
 *
 *   topic memo   `<sha256 of the original bytes>:zstd:base64`
 *   messages     `{"o": <order>, "c": <chunk>}`, chunks of `data:<mime>;base64,<zstd(bytes) as base64>`
 *   topic keys   a submit key (only the issuer can write) and no admin key (nobody can delete it)
 *
 * The memo makes the file content-addressed: whoever reads it recomputes the hash and rejects anything else. The Hiero
 * SDK ships an HCS-1 reader, but it only accepts `application/json`, so certificates use this codec.
 */
import { createHash } from "node:crypto";
import { compress, decompress } from "zstd-napi";
import { CertificateError } from "./errors";

/** Maximum `c` length per message; leaves room for the JSON envelope inside the 1024-byte HCS message limit. */
export const HCS1_CHUNK_SIZE = 960;
const MEMO = /^([0-9a-f]{64}):zstd:base64$/;
const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+);base64,/;

export interface Hcs1Encoding {
  memo: string;
  /** JSON messages to submit in order. */
  messages: string[];
}

export interface Hcs1File {
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function encodeHcs1(bytes: Uint8Array, mimeType: string): Hcs1Encoding {
  const content = `data:${mimeType};base64,${Buffer.from(compress(bytes, { compressionLevel: 10 })).toString("base64")}`;
  const messages: string[] = [];
  for (let offset = 0, order = 0; offset < content.length; offset += HCS1_CHUNK_SIZE, order++) {
    messages.push(JSON.stringify({ o: order, c: content.slice(offset, offset + HCS1_CHUNK_SIZE) }));
  }
  return { memo: `${sha256Hex(bytes)}:zstd:base64`, messages };
}

/**
 * Rebuilds a file from its topic memo and messages (in any order). Rejects missing, duplicated or malformed chunks and
 * any content whose hash differs from the memo, so a caller never sees bytes the memo does not vouch for.
 */
export function decodeHcs1(memo: string, messages: string[]): Hcs1File {
  const expected = MEMO.exec(memo)?.[1];
  if (!expected) throw new CertificateError("DOCUMENT_INVALID", "Topic memo is not an HCS-1 zstd/base64 memo.");

  const chunks = new Map<number, string>();
  for (const message of messages) {
    let parsed: { o?: unknown; c?: unknown };
    try {
      parsed = JSON.parse(message);
    } catch {
      throw new CertificateError("DOCUMENT_INVALID", "HCS-1 message is not JSON.");
    }
    if (!Number.isInteger(parsed.o) || typeof parsed.c !== "string") {
      throw new CertificateError("DOCUMENT_INVALID", "HCS-1 message must have an integer `o` and a string `c`.");
    }
    if (chunks.has(parsed.o as number)) {
      throw new CertificateError("DOCUMENT_INVALID", `HCS-1 chunk ${parsed.o} appears twice.`);
    }
    chunks.set(parsed.o as number, parsed.c);
  }
  for (let order = 0; order < chunks.size; order++) {
    if (!chunks.has(order)) throw new CertificateError("DOCUMENT_INVALID", `HCS-1 chunk ${order} is missing.`);
  }

  const content = Array.from({ length: chunks.size }, (_, order) => chunks.get(order)).join("");
  const mimeType = DATA_URI.exec(content)?.[1];
  if (!mimeType) throw new CertificateError("DOCUMENT_INVALID", "HCS-1 content does not start with a data URI.");

  let bytes: Uint8Array;
  try {
    bytes = decompress(Buffer.from(content.replace(DATA_URI, ""), "base64"));
  } catch {
    throw new CertificateError("DOCUMENT_INVALID", "HCS-1 content is not valid zstd.");
  }
  const sha256 = sha256Hex(bytes);
  if (sha256 !== expected) {
    throw new CertificateError("DOCUMENT_INVALID", "HCS-1 content does not match the hash in the topic memo.");
  }
  return { bytes, mimeType, sha256 };
}
