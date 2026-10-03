/**
 * An in-memory Hedera for offline tests (`yarn test` never touches a network).
 *
 * It replaces only the transport: `HederaHcsService` of the Hiero SDK (topics, ordered messages with consensus
 * timestamps, the `toDate` filter the Mirror Node applies) and the Mirror Node REST endpoints the HCS-1 reader uses.
 * Everything above it is the real code: Credo, the Hiero AnonCreds registry that rebuilds revocation state from topic
 * messages, our timestamp fix, the HCS-1 codec. DIDs are imported into the issuer wallet instead of being registered.
 */
import { createRequire } from "node:module";
import { DidDocument, TypedArrayEncoder, VerificationMethod } from "@credo-ts/core";
import type { Agent } from "@credo-ts/core";
import * as hcsEsm from "@hiero-did-sdk/hcs";
import { encodeHcs1 } from "../certificates/hcs1";
import type { AccreditationReader } from "../certificates/accreditation";
import type { PublishedFile } from "../certificates/ledger";

interface Topic {
  memo: string;
  adminKey: boolean;
  messages: { consensusTime: Date; contents: Buffer }[];
  file?: Buffer;
}

export class InMemoryHedera {
  readonly mirrorNodeUrl = "https://mirror.test";
  private readonly topics = new Map<string, Topic>();
  private nextTopic = 1000;
  private lastConsensus = 0;
  /** Set to make the next HCS-1 page served by the Mirror Node omit its last message. */
  dropLastChunk = false;

  private consensusNow(): Date {
    this.lastConsensus = Math.max(Date.now(), this.lastConsensus + 1);
    return new Date(this.lastConsensus);
  }

  createTopic(memo = "", adminKey = false): string {
    const id = `0.0.${this.nextTopic++}`;
    this.topics.set(id, { memo, adminKey, messages: [] });
    return id;
  }

  submit(topicId: string, message: string | Uint8Array): void {
    const topic = this.topics.get(topicId);
    if (!topic) throw new Error(`INVALID_TOPIC_ID ${topicId}`);
    topic.messages.push({ consensusTime: this.consensusNow(), contents: Buffer.from(message) });
  }

  messages(topicId: string): { consensusTime: Date; contents: Buffer }[] {
    return this.topics.get(topicId)?.messages ?? [];
  }

  /** Installs this ledger under the Hiero SDK (both module formats) for the rest of the test file. */
  install(): void {
    // Arrow functions: `this` is the in-memory ledger, not the patched service instance.
    const fake: Partial<hcsEsm.HederaHcsService> = {
      createTopic: async props => this.createTopic(props?.topicMemo ?? ""),
      getTopicInfo: async ({ topicId }) =>
        ({ topicId, topicMemo: this.topics.get(topicId)?.memo ?? "", submitKey: "fake" }) as hcsEsm.TopicInfo,
      submitMessage: async ({ topicId, message }) => {
        this.submit(topicId, message);
        return {} as hcsEsm.SubmitMessageResult;
      },
      getTopicMessages: async ({ topicId, toDate, limit }) => {
        let messages = this.messages(topicId);
        if (toDate) messages = messages.filter(message => message.consensusTime <= toDate);
        return limit ? messages.slice(0, limit) : messages;
      },
      submitFile: async ({ payload }) => {
        const topicId = this.createTopic();
        this.topics.get(topicId)!.file = Buffer.from(payload);
        return topicId;
      },
      resolveFile: async ({ topicId }) => {
        const file = this.topics.get(topicId)?.file;
        if (!file) throw new Error(`HCS file topic ${topicId} not found`);
        return file;
      },
    };
    const cjs = createRequire(import.meta.url)("@hiero-did-sdk/hcs") as typeof hcsEsm;
    for (const module of [hcsEsm, cjs]) Object.assign(module.HederaHcsService.prototype, fake);
  }

  /** Drop-in for `publishHcs1File`: stores the file the way HCS-1 does (memo + chunk messages). */
  publishFile = async (_config: unknown, bytes: Uint8Array, mimeType: string): Promise<PublishedFile> => {
    const { memo, messages } = encodeHcs1(bytes, mimeType);
    const topicId = this.createTopic(memo);
    for (const message of messages) this.submit(topicId, message);
    return { topicId, sha256: memo.split(":")[0], messageCount: messages.length };
  };

  /** Mirror Node REST for `/api/v1/topics/{id}` and `/api/v1/topics/{id}/messages` (two messages per page). */
  fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const match = /^\/api\/v1\/topics\/([\d.]+)(\/messages)?$/.exec(url.pathname);
    const topic = match && this.topics.get(match[1]);
    if (!match || !topic) return new Response("{}", { status: 404 });
    if (!match[2])
      return Response.json({ topic_id: match[1], memo: topic.memo, admin_key: topic.adminKey ? { key: "x" } : null });

    const pageSize = 2;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    let all = topic.messages;
    if (this.dropLastChunk) all = all.slice(0, -1);
    const page = all.slice(offset, offset + pageSize);
    const next =
      offset + pageSize < all.length ? `/api/v1/topics/${match[1]}/messages?offset=${offset + pageSize}` : null;
    return Response.json({
      messages: page.map(message => ({ message: message.contents.toString("base64") })),
      links: { next },
    });
  }) as typeof fetch;

  /** Replaces a stored message, as a corrupted or malicious Mirror Node would. */
  tamper(topicId: string, index: number, contents: string): void {
    this.messages(topicId)[index].contents = Buffer.from(contents);
  }
}

/** Gives `issuer` a `did:hedera` whose root key lives in its KMS, without registering it on a network. */
export async function importIssuerDid(issuer: Agent, topicId = "0.0.999"): Promise<string> {
  const { keyId, publicJwk } = await issuer.kms.createKey({ type: { kty: "OKP", crv: "Ed25519" } });
  if (publicJwk.kty !== "OKP") throw new Error("Expected an Ed25519 key.");
  const publicKey = Buffer.from(publicJwk.x, "base64url");
  const did = `did:hedera:testnet:${TypedArrayEncoder.toBase58(publicKey)}_${topicId}`;
  const rootKey = new VerificationMethod({
    id: `${did}#did-root-key`,
    type: "Ed25519VerificationKey2020",
    controller: did,
    publicKeyMultibase: `z${TypedArrayEncoder.toBase58(Uint8Array.from([0xed, 0x01, ...publicKey]))}`,
  });
  await issuer.dids.import({
    did,
    didDocument: new DidDocument({ id: did, verificationMethod: [rootKey], assertionMethod: [rootKey.id] }),
    keys: [{ kmsKeyId: keyId, didDocumentRelativeKeyId: "#did-root-key" }],
  });
  return did;
}

/** In-memory stand-in for the accreditation registry contract, with the same history rules. */
export class InMemoryAccreditation implements AccreditationReader {
  private readonly entries = new Map<string, { course: string; id: string; grantedAt: number; withdrawnAt?: number }>();
  private readonly now = () => Math.floor(Date.now() / 1000);

  accredit(course: string, id: string): void {
    if (this.entries.has(`${course}|${id}`)) throw new Error("AlreadyAccredited");
    this.entries.set(`${course}|${id}`, { course, id, grantedAt: this.now() });
  }

  withdraw(course: string, id: string): void {
    const entry = this.entries.get(`${course}|${id}`);
    if (!entry || entry.withdrawnAt) throw new Error("NotAccredited");
    entry.withdrawnAt = this.now();
  }

  async credentialDefinitions(course: string): Promise<string[]> {
    return [...this.entries.values()].filter(entry => entry.course === course).map(entry => entry.id);
  }

  async isAccredited(course: string, id: string, at: number): Promise<boolean> {
    const entry = this.entries.get(`${course}|${id}`);
    return !!entry && entry.grantedAt <= at && (entry.withdrawnAt === undefined || at < entry.withdrawnAt);
  }
}
