/**
 * An in-memory HCS topic behind the real `HcsTransport` port. Every accepted message gets the next sequence number and
 * a consensus timestamp from the caller's clock, and is appended to a `FakeWorld`, so the fake Mirror Node serves it.
 */
import type { HcsTransport, TransportReceipt, TransportRequest } from "../hedera/hcs/publisher";
import type { FakeWorld } from "./mirror";

export interface InMemoryTopicOptions {
  /** Payer of every transaction; also the account part of the transaction id. */
  payer?: string;
  /** Consensus time of the next message, `seconds.nanoseconds` with 9 fractional digits. */
  consensusAt: () => string;
  /** Hide each new message from the Mirror Node for its first N reads (indexing lag). */
  visibleAfterReads?: number;
  /** Throw instead of accepting the next submission (e.g. a Hedera SDK error). Cleared after use. */
  failNext?: Error;
}

export interface InMemoryTopic {
  transport: HcsTransport;
  requests: TransportRequest[];
  receipts: TransportReceipt[];
  /** Makes the next submission throw `error`; nothing is appended to the topic. */
  failNext(error: Error): void;
}

export function createInMemoryTopic(world: FakeWorld, options: InMemoryTopicOptions): InMemoryTopic {
  const payer = options.payer ?? "0.0.1001";
  const requests: TransportRequest[] = [];
  const receipts: TransportReceipt[] = [];
  let pendingFailure = options.failNext;

  const transport: HcsTransport = {
    async submit(request) {
      requests.push(request);
      const consensusTimestamp = options.consensusAt();
      const transactionId = `${payer}@${consensusTimestamp.split(".")[0]}.000000000`;
      request.onTransactionId(transactionId);
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = undefined;
        throw error;
      }
      if (world.topicId && world.topicId !== request.topicId) throw new Error(`INVALID_TOPIC_ID ${request.topicId}`);
      const sequence = world.messages.reduce((max, m) => (m.sequence > max ? m.sequence : max), 0n) + 1n;
      world.messages.push({
        sequence,
        consensusTimestamp,
        bytes: request.message,
        payer,
        visibleAfterReads: options.visibleAfterReads,
      });
      const receipt: TransportReceipt = {
        transactionId,
        sequenceNumber: sequence.toString(),
        runningHash: "ab".repeat(48),
        consensusTimestamp,
      };
      receipts.push(receipt);
      return receipt;
    },
  };

  return {
    transport,
    requests,
    receipts,
    failNext(error) {
      pendingFailure = error;
    },
  };
}
