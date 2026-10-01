import { describe, expect, it } from "vitest";
import { IssuerFlowError } from "./errors";
import { runIssuance, runRevocation } from "./issuer-flow";
import type { IssuerFlowContext } from "./issuer-flow";
import {
  CHAIN_ID,
  DRAFT_INPUT,
  ISSUER_ADDRESS,
  NOW_MS,
  OTHER_WALLET,
  REGISTRY_ADDRESS,
  TX_HASH,
  fakeBackend,
  fakeWallet,
  publishReceipt,
  revertError,
} from "./issuer-test-fixtures";

function context(
  wallet: ReturnType<typeof fakeWallet>,
  backend = fakeBackend().backend,
  extra: Partial<IssuerFlowContext> = {},
): IssuerFlowContext {
  let clock = NOW_MS;
  return {
    provider: wallet.provider,
    backend,
    chainId: CHAIN_ID,
    registryAddress: REGISTRY_ADDRESS,
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    },
    ...extra,
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IssuerFlowError);
    return (error as IssuerFlowError).issuerError;
  }
  throw new Error("expected a failure");
}

describe("runIssuance", () => {
  it("signs, dry-runs, publishes to HCS and only then sends the registry transaction (ADR D11)", async () => {
    const wallet = fakeWallet();
    const { backend, published } = fakeBackend();
    const steps: string[] = [];
    const outcome = await runIssuance(DRAFT_INPUT, context(wallet, backend), e => steps.push(`${e.step}:${e.state}`));

    const order = wallet.methods();
    const publishedAt = order.indexOf("eth_sendTransaction");
    expect(order.slice(0, 4)).toEqual(["eth_accounts", "eth_chainId", "eth_signTypedData_v4", "eth_call"]);
    expect(publishedAt).toBeGreaterThan(order.indexOf("eth_call"));
    expect(published).toHaveLength(1);
    expect(steps).toEqual([
      "build:active",
      "build:done",
      "sign:active",
      "sign:done",
      "simulate:active",
      "simulate:done",
      "publish:active",
      "publish:done",
      "register:active",
      "register:done",
      "confirm:active",
      "confirm:done",
    ]);
    expect(outcome.registration.transactionHash).toBe(TX_HASH);
    expect(outcome.hcs.hcsRef.sequence).toBe("42");
    // T-5/F-1: the published event is pinned to the account that sends issue(), so nobody can front-run it.
    expect(outcome.event.submitter).toBe(ISSUER_ADDRESS);
    expect((published[0] as { event: { submitter: string } }).event.submitter).toBe(ISSUER_ADDRESS);
    const sent = wallet.calls.find(c => c.method === "eth_sendTransaction")!.params![0] as { from: string };
    expect(sent.from).toBe(ISSUER_ADDRESS);
    // The subject identifier never leaves the browser: only its salted commitment is published.
    expect(JSON.stringify(published)).not.toContain(DRAFT_INPUT.subjectIdValue);
    expect(outcome.document.subject.idValue).toBe(DRAFT_INPUT.subjectIdValue);
    expect(JSON.stringify(published)).not.toContain(outcome.subjectSalt);
  });

  it("sends the transaction with the HcsRef from the consensus receipt, not the dry-run placeholder", async () => {
    const wallet = fakeWallet();
    const { backend } = fakeBackend({
      publish: async () => publishReceipt({ hcsRef: { sequence: "777", consensusTimestampNs: "5" } }),
    });
    await runIssuance(DRAFT_INPUT, context(wallet, backend));
    const sent = wallet.calls.find(c => c.method === "eth_sendTransaction")!.params![0] as { data: string };
    const dry = wallet.calls.find(c => c.method === "eth_call")!.params![0] as { data: string };
    expect(sent.data).toContain((777).toString(16).padStart(64, "0"));
    expect(dry.data).not.toBe(sent.data);
  });

  it("fails with wallet_disconnected without a provider or an account", async () => {
    expect((await failure(runIssuance(DRAFT_INPUT, { ...context(fakeWallet()), provider: null }))).category).toBe(
      "wallet_disconnected",
    );
    expect((await failure(runIssuance(DRAFT_INPUT, context(fakeWallet({ accounts: [] }))))).category).toBe(
      "wallet_disconnected",
    );
  });

  it("fails with wrong_network on another chain, before signing", async () => {
    const wallet = fakeWallet({ chainId: "0x127" });
    const error = await failure(runIssuance(DRAFT_INPUT, context(wallet)));
    expect(error.category).toBe("wrong_network");
    expect(wallet.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("reports invalid fields without signing", async () => {
    const wallet = fakeWallet();
    const error = await failure(runIssuance({ ...DRAFT_INPUT, reference: "" }, context(wallet)));
    expect(error.category).toBe("invalid_input");
    expect(error.issues?.map(i => i.field)).toEqual(["reference"]);
    expect(wallet.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("fails with rejected when the person declines the signature; nothing is published", async () => {
    const { backend, published } = fakeBackend();
    const wallet = fakeWallet({
      overrides: { eth_signTypedData_v4: Object.assign(new Error("denied"), { code: 4001 }) },
    });
    expect((await failure(runIssuance(DRAFT_INPUT, context(wallet, backend)))).category).toBe("rejected");
    expect(published).toHaveLength(0);
  });

  it("refuses a signature made by another key than the connected account", async () => {
    const wallet = fakeWallet({ wallet: OTHER_WALLET });
    expect((await failure(runIssuance(DRAFT_INPUT, context(wallet)))).code).toBe("SIGNER_MISMATCH");
  });

  it("stops at the dry-run when the issuer is not registered: no HCS fee is spent", async () => {
    const { backend, published } = fakeBackend();
    const wallet = fakeWallet({ overrides: { eth_call: revertError("UnknownIssuer", [`0x${"44".repeat(32)}`]) } });
    const error = await failure(runIssuance(DRAFT_INPUT, context(wallet, backend)));
    expect(error.category).toBe("issuer_not_registered");
    expect(published).toHaveLength(0);
    expect(wallet.methods()).not.toContain("eth_sendTransaction");
  });

  it("never sends the transaction when the HCS publication fails", async () => {
    const wallet = fakeWallet();
    const { backend } = fakeBackend({
      publish: async () => {
        throw new IssuerFlowError({
          category: "hedera",
          code: "INSUFFICIENT_PAYER_BALANCE",
          title: "t",
          message: "m",
          remediation: "r",
        });
      },
    });
    expect((await failure(runIssuance(DRAFT_INPUT, context(wallet, backend)))).category).toBe("hedera");
    expect(wallet.methods()).not.toContain("eth_sendTransaction");
  });

  it("classifies a dry-run that does not answer in time as a timeout", async () => {
    const wallet = fakeWallet({ overrides: { eth_call: () => new Promise(() => undefined) } });
    const error = await failure(runIssuance(DRAFT_INPUT, context(wallet, undefined, { callTimeoutMs: 5 })));
    expect(error.category).toBe("timeout");
  });

  it("times out waiting for the receipt and keeps the transaction hash", async () => {
    const wallet = fakeWallet({ receipts: [null] });
    const error = await failure(runIssuance(DRAFT_INPUT, context(wallet, undefined, { receiptTimeoutMs: 10_000 })));
    expect(error.category).toBe("timeout");
    expect(error.transactionHash).toBe(TX_HASH);
  });

  it("keeps polling through transient relay failures", async () => {
    const wallet = fakeWallet({ receipts: [new Error("fetch failed"), null, { status: "0x1", blockNumber: "0x1" }] });
    const outcome = await runIssuance(DRAFT_INPUT, context(wallet));
    expect(outcome.registration.transactionHash).toBe(TX_HASH);
  });

  it("explains a reverted transaction with the replayed reason", async () => {
    let calls = 0;
    const wallet = fakeWallet({
      receipts: [{ status: "0x0" }],
      overrides: {
        eth_call: () => {
          calls += 1;
          if (calls === 1) return "0x";
          throw revertError("AlreadyIssued", [`0x${"11".repeat(32)}`, 1790000000n]);
        },
      },
    });
    const error = await failure(runIssuance(DRAFT_INPUT, context(wallet)));
    expect(error.code).toBe("AlreadyIssued");
    expect(error.transactionHash).toBe(TX_HASH);
  });
});

describe("runRevocation", () => {
  const ID = `0x${"11".repeat(32)}`;

  it("checks the status, signs the evidence, publishes it, then sends revoke", async () => {
    const wallet = fakeWallet();
    const { backend, published } = fakeBackend();
    const outcome = await runRevocation({ credentialId: ID, reason: "superseded" }, context(wallet, backend));
    expect(wallet.methods()).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_signTypedData_v4",
      "eth_call",
      "eth_sendTransaction",
      "eth_getTransactionReceipt",
    ]);
    expect(published).toEqual([expect.objectContaining({ kind: "revocation" })]);
    expect(outcome.revocation.issuer).toBe(`0x${"44".repeat(32)}`);
  });

  it("refuses an unknown or already revoked credential before signing", async () => {
    for (const [status, code] of [
      ["not_found", "UnknownCredential"],
      ["revoked", "AlreadyRevoked"],
    ] as const) {
      const wallet = fakeWallet();
      const error = await failure(
        runRevocation(
          { credentialId: ID, reason: "unspecified" },
          context(wallet, fakeBackend({ status: { status, revokedAt: "1790000000" } }).backend),
        ),
      );
      expect(error.code).toBe(code);
      expect(wallet.methods()).not.toContain("eth_signTypedData_v4");
    }
  });

  it("stops at the dry-run when the wallet may not revoke", async () => {
    const { backend, published } = fakeBackend();
    const wallet = fakeWallet({ overrides: { eth_call: revertError("UnauthorizedRevoker", [ID, ISSUER_ADDRESS]) } });
    const error = await failure(runRevocation({ credentialId: ID, reason: "unspecified" }, context(wallet, backend)));
    expect(error.code).toBe("UnauthorizedRevoker");
    expect(published).toHaveLength(0);
  });

  it("validates the credential id", async () => {
    const error = await failure(
      runRevocation({ credentialId: "0x1234", reason: "unspecified" }, context(fakeWallet())),
    );
    expect(error.category).toBe("invalid_input");
  });
});
