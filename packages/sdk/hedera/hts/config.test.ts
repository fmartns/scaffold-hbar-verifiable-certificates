import { describe, expect, it } from "vitest";
import { HTS_ENV, loadHtsAdapterConfig } from "./config";
import { HtsError } from "./errors";
import { OPERATOR, ROUTER_ADDRESS, TOKEN } from "./test-fixtures";

const env = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_HTS_TOKEN_ID: TOKEN,
  HEDERA_SETTLEMENT_ROUTER_ADDRESS: ROUTER_ADDRESS,
  ...extra,
});
const operatorEnv = (extra: Record<string, string> = {}) =>
  env({ HEDERA_HTS_CUSTODY: "operator", HEDERA_OPERATOR_ID: OPERATOR, ...extra });

function failure(e: Record<string, string | undefined>) {
  try {
    loadHtsAdapterConfig(e);
  } catch (error) {
    if (error instanceof HtsError) return error.failure;
    throw error;
  }
  throw new Error("expected CONFIG_INVALID");
}

describe("loadHtsAdapterConfig", () => {
  it("defaults to the ADR: router custody and the mint-transfer model", () => {
    expect(loadHtsAdapterConfig(env())).toMatchObject({
      tokenId: TOKEN,
      model: "mint-transfer",
      custody: "router",
      routerAddress: ROUTER_ADDRESS,
    });
  });

  it("reads the token and model from the environment, nothing hardcoded", () => {
    const a = loadHtsAdapterConfig(
      env({ HEDERA_HTS_TOKEN_ID: "0.0.777", HEDERA_HTS_SETTLEMENT_MODEL: "pool-transfer" }),
    );
    expect(a).toMatchObject({ tokenId: "0.0.777", model: "pool-transfer" });
  });

  it("uses the operator as treasury under operator custody, unless another is configured", () => {
    expect(loadHtsAdapterConfig(operatorEnv())).toMatchObject({
      custody: "operator",
      treasuryId: OPERATOR,
      operatorId: OPERATOR,
    });
    expect(loadHtsAdapterConfig(operatorEnv({ HEDERA_HTS_TREASURY_ID: "0.0.4242" })).treasuryId).toBe("0.0.4242");
  });

  it("does not need the router address under operator custody", () => {
    expect(
      loadHtsAdapterConfig({ ...operatorEnv(), HEDERA_SETTLEMENT_ROUTER_ADDRESS: "" }).routerAddress,
    ).toBeUndefined();
  });

  it("refuses operator custody on mainnet (an off-chain key must not be able to mint in production, ADR D12)", () => {
    const f = failure(operatorEnv({ HEDERA_NETWORK: "mainnet" }));
    expect(f).toMatchObject({ code: "CONFIG_INVALID", outcome: "not_sent" });
    expect(f.message).toMatch(/D12|production/);
  });

  it("reports every problem at once, as CONFIG_INVALID with the variable and the remedy", () => {
    const f = failure({});
    expect(f.code).toBe("CONFIG_INVALID");
    expect(f.configIssues?.map(i => i.variable)).toEqual([HTS_ENV.TOKEN_ID, "HEDERA_SETTLEMENT_ROUTER_ADDRESS"]);
  });

  it.each([
    [{ HEDERA_HTS_TOKEN_ID: "abc" }, HTS_ENV.TOKEN_ID],
    [{ HEDERA_HTS_TOKEN_ID: "0.0.0" }, HTS_ENV.TOKEN_ID],
    [{ HEDERA_HTS_SETTLEMENT_MODEL: "burn" }, HTS_ENV.MODEL],
    [{ HEDERA_HTS_CUSTODY: "wallet" }, HTS_ENV.CUSTODY],
    [{ HEDERA_SETTLEMENT_ROUTER_ADDRESS: "0x1234" }, "HEDERA_SETTLEMENT_ROUTER_ADDRESS"],
    [{ HEDERA_NETWORK: "devnet" }, "HEDERA_NETWORK"],
  ])("rejects %j", (override, variable) => {
    expect(failure(env(override)).configIssues?.map(i => i.variable)).toContain(variable);
  });

  it("requires the operator account under operator custody", () => {
    expect(failure(env({ HEDERA_HTS_CUSTODY: "operator" })).configIssues?.map(i => i.variable)).toContain(
      "HEDERA_OPERATOR_ID",
    );
    expect(failure(operatorEnv({ HEDERA_HTS_TREASURY_ID: "nope" })).configIssues?.map(i => i.variable)).toContain(
      HTS_ENV.TREASURY_ID,
    );
  });

  it("never echoes secrets", () => {
    expect(JSON.stringify(failure({ HEDERA_OPERATOR_KEY: "302e020100300506032b657004220420aabbccdd" }))).not.toContain(
      "aabbccdd",
    );
  });
});
