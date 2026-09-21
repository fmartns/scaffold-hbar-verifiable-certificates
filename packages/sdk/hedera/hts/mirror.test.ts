import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { HtsError } from "./errors";
import { createHtsMirror } from "./mirror";
import { settlementMemo } from "./settlement";
import { EVENT_KEY, TOKEN } from "./test-fixtures";

const answer = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function mirrorWith(handler: (url: URL) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    return handler(url);
  }) as typeof fetch;
  return { mirror: createHtsMirror(NETWORKS.testnet, { fetch: fetchImpl }), urls };
}

describe("getToken", () => {
  const raw = {
    token_id: TOKEN,
    type: "FUNGIBLE_COMMON",
    deleted: false,
    pause_status: "UNPAUSED",
    supply_type: "FINITE",
    max_supply: "9223372036854775807",
    total_supply: "1000",
    treasury_account_id: "0.0.1234",
    decimals: "2",
    freeze_default: false,
    supply_key: { _type: "ED25519", key: "ABCD" },
    kyc_key: null,
    freeze_key: null,
    symbol: "SETL",
  };

  it("maps the token, keeping int64 supplies exact", async () => {
    const { mirror, urls } = mirrorWith(() => answer(raw));
    expect(await mirror.getToken(TOKEN)).toMatchObject({
      tokenId: TOKEN,
      type: "FUNGIBLE_COMMON",
      paused: false,
      supplyType: "FINITE",
      maxSupply: 9223372036854775807n,
      totalSupply: 1000n,
      treasuryAccountId: "0.0.1234",
      supplyKey: { type: "ED25519", key: "abcd" },
      kycKey: null,
      decimals: 2,
    });
    expect(urls).toEqual([`/api/v1/tokens/${TOKEN}`]);
  });

  it("reports a paused token, and null for an unknown one", async () => {
    expect((await mirrorWith(() => answer({ ...raw, pause_status: "PAUSED" })).mirror.getToken(TOKEN))?.paused).toBe(
      true,
    );
    expect(await mirrorWith(() => answer({ _status: {} }, 404)).mirror.getToken("0.0.99")).toBeNull();
  });
});

describe("getRelationship", () => {
  it("returns null when the account is not associated", async () => {
    expect(await mirrorWith(() => answer({ tokens: [] })).mirror.getRelationship("0.0.9", TOKEN)).toBeNull();
  });

  it("reads a balance above 2^53 exactly from the raw JSON number", async () => {
    const text = `{"tokens":[{"token_id":"${TOKEN}","balance":9007199254740993123,"freeze_status":"UNFROZEN","kyc_status":"GRANTED","automatic_association":true}]}`;
    const { mirror, urls } = mirrorWith(() => answer(text));
    expect(await mirror.getRelationship("0.0.9", TOKEN)).toEqual({
      balance: 9007199254740993123n,
      freezeStatus: "UNFROZEN",
      kycStatus: "GRANTED",
      automatic: true,
    });
    expect(urls).toEqual([`/api/v1/accounts/0.0.9/tokens?token.id=${TOKEN}`]);
  });

  it("ignores a relationship with another token", async () => {
    expect(
      await mirrorWith(() => answer({ tokens: [{ token_id: "0.0.1", balance: 5 }] })).mirror.getRelationship(
        "0.0.9",
        TOKEN,
      ),
    ).toBeNull();
  });
});

describe("getAccount and getContractId", () => {
  it("maps an account, including automatic associations", async () => {
    const { mirror } = mirrorWith(() =>
      answer({ account: "0.0.9", deleted: false, max_automatic_token_associations: -1, evm_address: "0xABCD" }),
    );
    expect(await mirror.getAccount("0.0.9")).toEqual({
      accountId: "0.0.9",
      deleted: false,
      maxAutomaticTokenAssociations: -1,
      evmAddress: "0xabcd",
    });
  });

  it("returns null for an unknown account or contract", async () => {
    const { mirror } = mirrorWith(() => answer({}, 404));
    expect(await mirror.getAccount("0.0.1")).toBeNull();
    expect(await mirror.getContractId("0x00")).toBeNull();
  });

  it("resolves a contract id from its EVM address", async () => {
    const { mirror, urls } = mirrorWith(() => answer({ contract_id: "0.0.7000" }));
    expect(await mirror.getContractId("0x5fbd")).toBe("0.0.7000");
    expect(urls).toEqual(["/api/v1/contracts/0x5fbd"]);
  });
});

describe("findSettlementTransactions", () => {
  const b64 = (memo: string) => Buffer.from(memo).toString("base64");
  const tx = (id: string, memo: string, result = "SUCCESS") => ({
    transaction_id: id,
    consensus_timestamp: "1.5",
    result,
    memo_base64: b64(memo),
  });

  it("finds only the transactions whose memo is a settlement memo of this event key", async () => {
    const { mirror, urls } = mirrorWith(() =>
      answer({
        transactions: [
          tx("0.0.1-1-1", settlementMemo(EVENT_KEY, "mint")),
          tx("0.0.1-1-2", settlementMemo(`0x${"aa".repeat(32)}`, "mint")),
          tx("0.0.1-1-3", "hello"),
          tx("0.0.1-1-4", settlementMemo(EVENT_KEY, "transfer"), "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT"),
          { transaction_id: "0.0.1-1-5", consensus_timestamp: "2.5", result: "SUCCESS" },
        ],
        links: { next: null },
      }),
    );
    expect(await mirror.findSettlementTransactions("0.0.1", EVENT_KEY.toUpperCase().replace("0X", "0x"), 100)).toEqual([
      { step: "mint", transactionId: "0.0.1-1-1", consensusTimestamp: "1.5", result: "SUCCESS" },
      {
        step: "transfer",
        transactionId: "0.0.1-1-4",
        consensusTimestamp: "1.5",
        result: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
      },
    ]);
    expect(urls[0]).toBe("/api/v1/transactions?account.id=0.0.1&timestamp=gte:100&order=desc&limit=100");
  });

  it("follows the next-page links, up to a bound", async () => {
    let page = 0;
    const { mirror, urls } = mirrorWith(() => {
      page++;
      return answer({
        transactions: page === 2 ? [tx("0.0.1-1-9", settlementMemo(EVENT_KEY, "transfer"))] : [],
        links: { next: `/api/v1/transactions?page=${page + 1}` },
      });
    });
    const found = await mirror.findSettlementTransactions("0.0.1", EVENT_KEY, 0);
    expect(found).toHaveLength(1);
    expect(urls).toHaveLength(5); // bounded: it does not page forever
    expect(urls[1]).toBe("/api/v1/transactions?page=2");
  });

  it("reads a single transaction by its Mirror id", async () => {
    const { mirror } = mirrorWith(() =>
      answer({
        transactions: [
          { transaction_id: "0.0.1-1-1", consensus_timestamp: "1.5", result: "SUCCESS", name: "TOKENMINT" },
        ],
      }),
    );
    expect(await mirror.getTransaction("0.0.1-1-1")).toEqual({
      transactionId: "0.0.1-1-1",
      consensusTimestamp: "1.5",
      result: "SUCCESS",
      name: "TOKENMINT",
    });
    expect(await mirrorWith(() => answer({}, 404)).mirror.getTransaction("x")).toBeNull();
  });
});

describe("Mirror failures are normalized, never raw", () => {
  it.each([
    ["a network error", () => Promise.reject(new Error("connect ECONNREFUSED secret-host"))],
    ["an HTTP 503", () => answer("", 503)],
    ["a malformed body", () => answer("<html>")],
  ])("%s becomes NETWORK_UNAVAILABLE / not_sent", async (_, handler) => {
    const error = await mirrorWith(handler)
      .mirror.getToken(TOKEN)
      .catch(e => e);
    expect(error).toBeInstanceOf(HtsError);
    expect(error.failure).toMatchObject({ code: "NETWORK_UNAVAILABLE", outcome: "not_sent", retryable: true });
    expect(JSON.stringify(error.failure)).not.toContain("secret-host");
  });
});
