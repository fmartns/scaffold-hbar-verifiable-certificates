/**
 * HCS-1 documents on Hedera: written with the operator account, read back from the Mirror Node.
 *
 * Writes wait for each consensus receipt. Reads are eventual-consistency aware: right after an upload the Mirror Node
 * may not list every chunk yet, so `publishHcs1File` polls until the file decodes before reporting success.
 */
import { Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import type { CertificatesConfig } from "./config";
import { CertificateError } from "./errors";
import { decodeHcs1, encodeHcs1 } from "./hcs1";
import type { Hcs1File } from "./hcs1";

const MIRROR_TIMEOUT_MS = 10_000;
const VISIBILITY_TIMEOUT_MS = 60_000;

export function createLedgerClient(config: CertificatesConfig): Client {
  return Client.forName(config.network).setOperator(config.operatorId, PrivateKey.fromStringDer(config.operatorKeyDer));
}

async function mirrorJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
  } catch {
    throw new CertificateError("LEDGER_READ_FAILED", `Mirror Node unreachable (${new URL(url).origin}).`);
  }
  if (response.status === 404)
    throw new CertificateError("NOT_FOUND", "The Mirror Node does not know this topic (yet).");
  if (!response.ok) throw new CertificateError("LEDGER_READ_FAILED", `Mirror Node answered HTTP ${response.status}.`);
  return (await response.json()) as T;
}

/** Reads an HCS-1 file and verifies it against its memo. Rejects topics with an admin key (they can be changed). */
export async function fetchHcs1File(
  mirrorNodeUrl: string,
  topicId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Hcs1File> {
  if (!/^\d+\.\d+\.\d+$/.test(topicId)) throw new CertificateError("INVALID_INPUT", "Invalid topic id.");
  const base = mirrorNodeUrl.replace(/\/+$/, "");
  const topic = await mirrorJson<{ memo: string; admin_key: unknown }>(`${base}/api/v1/topics/${topicId}`, fetchImpl);
  if (topic.admin_key) throw new CertificateError("DOCUMENT_INVALID", "The document topic has an admin key.");

  const messages: string[] = [];
  let next: string | null = `/api/v1/topics/${topicId}/messages?limit=100&order=asc`;
  while (next) {
    const page: { messages: { message: string }[]; links?: { next?: string | null } } = await mirrorJson(
      `${base}${next}`,
      fetchImpl,
    );
    messages.push(...page.messages.map(item => Buffer.from(item.message, "base64").toString("utf8")));
    next = page.links?.next ?? null;
  }
  return decodeHcs1(topic.memo, messages);
}

export interface PublishedFile {
  topicId: string;
  sha256: string;
  messageCount: number;
}

/** Stores `bytes` as an HCS-1 file: a new topic (memo = hash, submit key = operator, no admin key) plus its chunks. */
export async function publishHcs1File(
  config: CertificatesConfig,
  bytes: Uint8Array,
  mimeType: string,
  options: { fetchImpl?: typeof fetch; client?: Client } = {},
): Promise<PublishedFile> {
  const { memo, messages } = encodeHcs1(bytes, mimeType);
  const client = options.client ?? createLedgerClient(config);
  let topicId: string;
  try {
    const submitKey = PrivateKey.fromStringDer(config.operatorKeyDer).publicKey;
    const receipt = await (
      await new TopicCreateTransaction().setTopicMemo(memo).setSubmitKey(submitKey).execute(client)
    ).getReceipt(client);
    topicId = receipt.topicId!.toString();
    for (const message of messages) {
      await (
        await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(client)
      ).getReceipt(client);
    }
  } catch (error) {
    throw new CertificateError(
      "LEDGER_WRITE_FAILED",
      `Could not store the document on HCS: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (!options.client) client.close();
  }

  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  for (;;) {
    try {
      const file = await fetchHcs1File(config.mirrorNodeUrl, topicId, options.fetchImpl);
      return { topicId, sha256: file.sha256, messageCount: messages.length };
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}
