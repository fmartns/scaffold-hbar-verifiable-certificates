import { describe, expect, it } from "vitest";
import { decodeContractIdKey, runHtsPreflight } from "./preflight";
import type { HtsPreflightContext } from "./preflight";
import { validateSettlementInput } from "./settlement";
import type { WorldOptions } from "./test-fixtures";
import {
  BENEFICIARY,
  OPERATOR,
  OPERATOR_PUBLIC_KEY,
  ROUTER_ADDRESS,
  ROUTER_CONTRACT,
  TOKEN,
  contractKeyHex,
  makeInput,
  operatorConfig,
  routerConfig,
  world,
} from "./test-fixtures";

function settlement(override = {}) {
  const parsed = validateSettlementInput(makeInput(override));
  if (!parsed.ok) throw new Error("fixture");
  return parsed.value;
}

async function check(options: WorldOptions, ctx: Partial<HtsPreflightContext> = {}, input = {}) {
  const w = world(options);
  const result = await runHtsPreflight({
    config: operatorConfig(),
    mirror: w.mirror,
    settlement: settlement(input),
    operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
    ...ctx,
  });
  return { result, w };
}

describe("decodeContractIdKey (Mirror's ProtobufEncoded contract keys)", () => {
  it("decodes the key observed on Testnet: token 0.0.10589073 has delegatable contract 0.0.10589072", () => {
    expect(decodeContractIdKey("42051890a78605")).toBe("0.0.10589072");
  });

  it("decodes contractID and delegatableContractId keys built by hand", () => {
    expect(decodeContractIdKey(contractKeyHex(7000))).toBe("0.0.7000");
    expect(decodeContractIdKey(contractKeyHex(7000, true))).toBe("0.0.7000");
    expect(decodeContractIdKey(contractKeyHex(1))).toBe("0.0.1");
  });

  it("returns null for a threshold key, a key list and malformed input", () => {
    expect(decodeContractIdKey("2a720802126e0a2212202cd3204c8a348cab5de7deb2b9f416d6038fddbb")).toBeNull();
    for (const bad of ["", "zz", "0a", "0a05", "0a0518", contractKeyHex(7000) + "00"])
      expect(decodeContractIdKey(bad)).toBeNull();
  });
});

describe("runHtsPreflight, operator custody, mint-transfer", () => {
  it("passes when the token, the custody, the supply key and the beneficiary are all right", async () => {
    const { result } = await check({});
    expect(result).toMatchObject({
      ok: true,
      association: "associated",
      treasuryId: OPERATOR,
      beneficiaryAccountId: BENEFICIARY,
    });
    expect(result.checks.map(c => c.id)).toEqual([
      "token-exists",
      "token-usable",
      "custody-treasury",
      "mint-permission",
      "beneficiary-exists",
      "beneficiary-associated",
    ]);
    expect(result.failure).toBeUndefined();
  });

  it("token does not exist -> TOKEN_NOT_FOUND, and nothing else is checked", async () => {
    const { result } = await check({ token: null });
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "TOKEN_NOT_FOUND", outcome: "not_sent", operation: "preflight" },
    });
    expect(result.checks).toHaveLength(1);
  });

  it("deleted, paused and non-fungible tokens are TOKEN_INVALID / TOKEN_PAUSED", async () => {
    expect((await check({ token: { deleted: true } })).result.failure?.code).toBe("TOKEN_INVALID");
    expect((await check({ token: { paused: true } })).result.failure?.code).toBe("TOKEN_PAUSED");
    const nft = (await check({ token: { type: "NON_FUNGIBLE_UNIQUE" } })).result.failure;
    expect(nft?.code).toBe("TOKEN_INVALID");
    expect(nft?.message).toMatch(/NON_FUNGIBLE_UNIQUE/);
  });

  it("beneficiary not associated -> NOT_ASSOCIATED, naming the account, token and the action", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    const result = await runHtsPreflight({
      config: operatorConfig(),
      mirror: w.mirror,
      settlement: settlement(),
      operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
    });
    expect(result.association).toBe("not_associated");
    expect(result.failure).toMatchObject({
      code: "NOT_ASSOCIATED",
      outcome: "not_sent",
      retryable: true,
      accountId: BENEFICIARY,
      tokenId: TOKEN,
    });
    expect(result.failure?.remediation).toMatch(/associate/i);
    expect(result.failure?.hederaStatus).toBeUndefined(); // nothing reached the network
  });

  it("a not-associated beneficiary that allows automatic association is a warning, not a failure", async () => {
    const w = world({ accounts: { [BENEFICIARY]: { maxAutomaticTokenAssociations: -1 } } });
    w.removeAssociation(BENEFICIARY);
    const result = await runHtsPreflight({
      config: operatorConfig(),
      mirror: w.mirror,
      settlement: settlement(),
      operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
    });
    expect(result).toMatchObject({ ok: true, association: "auto_association_possible" });
    expect(result.checks.find(c => c.id === "beneficiary-associated")).toMatchObject({ severity: "warning", ok: true });
  });

  it("frozen and KYC-less beneficiaries fail with their own codes", async () => {
    const frozen = world();
    frozen.setRelationship(BENEFICIARY, { freezeStatus: "FROZEN" });
    expect(
      (
        await runHtsPreflight({
          config: operatorConfig(),
          mirror: frozen.mirror,
          settlement: settlement(),
          operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        })
      ).failure?.code,
    ).toBe("ACCOUNT_FROZEN");
    const kyc = world({ token: { kycKey: { type: "ED25519", key: "cd".repeat(32) } } });
    kyc.setRelationship(BENEFICIARY, { kycStatus: "REVOKED" });
    expect(
      (
        await runHtsPreflight({
          config: operatorConfig(),
          mirror: kyc.mirror,
          settlement: settlement(),
          operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        })
      ).failure?.code,
    ).toBe("KYC_NOT_GRANTED");
  });

  it("beneficiary that does not exist or was deleted -> ACCOUNT_NOT_FOUND", async () => {
    expect((await check({}, {}, { beneficiary: "0.0.424242" })).result.failure?.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await check({ accounts: { [BENEFICIARY]: { deleted: true } } })).result.failure?.code).toBe(
      "ACCOUNT_NOT_FOUND",
    );
  });

  it("resolves an EVM-address beneficiary through Mirror", async () => {
    const { result } = await check(
      { accounts: { [BENEFICIARY]: { evmAddress: "0x00000000000000000000000000000000000023f9" } } },
      {},
      { beneficiary: "0x00000000000000000000000000000000000023F9" },
    );
    expect(result).toMatchObject({ ok: true, beneficiaryAccountId: BENEFICIARY });
  });

  it("the treasury cannot be the beneficiary", async () => {
    expect((await check({}, {}, { beneficiary: OPERATOR })).result.failure?.code).toBe("INVALID_SETTLEMENT");
  });

  it("the custodian must be the token's treasury", async () => {
    const failure = (await check({ token: { treasuryAccountId: "0.0.4242" } })).result.failure;
    expect(failure).toMatchObject({ code: "CONFIG_INVALID" });
    expect(failure?.message).toContain("0.0.4242");
  });

  describe("mint permission", () => {
    it("a token without a supply key cannot be minted", async () => {
      expect((await check({ token: { supplyKey: null } })).result.failure?.code).toBe("NO_MINT_PERMISSION");
    });

    it("a supply key that is not the operator's is NO_MINT_PERMISSION", async () => {
      const failure = (await check({ token: { supplyKey: { type: "ED25519", key: "cd".repeat(32) } } })).result.failure;
      expect(failure).toMatchObject({ code: "NO_MINT_PERMISSION" });
      expect(failure?.remediation).toMatch(/pool-transfer/);
    });

    it("a complex supply key cannot be confirmed: a warning, not a block", async () => {
      const { result } = await check({ token: { supplyKey: { type: "ProtobufEncoded", key: "2a00" } } });
      expect(result.ok).toBe(true);
      expect(result.checks.find(c => c.id === "mint-permission")?.severity).toBe("warning");
    });

    it("is skipped when resuming after the mint was applied", async () => {
      const { result } = await check({ token: { supplyKey: null } }, { skipMint: true });
      expect(result.ok).toBe(true);
      expect(result.checks.some(c => c.id === "mint-permission")).toBe(false);
    });
  });

  it("a finite supply without enough headroom is SUPPLY_EXCEEDED", async () => {
    const failure = (await check({ token: { supplyType: "FINITE", maxSupply: 1500n, totalSupply: 1000n } })).result
      .failure;
    expect(failure).toMatchObject({ code: "SUPPLY_EXCEEDED" });
    expect(failure?.message).toContain("500");
    expect((await check({ token: { supplyType: "FINITE", maxSupply: 2000n, totalSupply: 1000n } })).result.ok).toBe(
      true,
    );
  });

  it("tokenOnly checks the token and the custody, not the beneficiary", async () => {
    const { result } = await check({}, { tokenOnly: true });
    expect(result.ok).toBe(true);
    expect(result.checks.some(c => c.id.startsWith("beneficiary"))).toBe(false);
  });
});

describe("runHtsPreflight, router custody (ADR v1)", () => {
  const routerWorld = (token: WorldOptions["token"] = {}) =>
    world({
      token: {
        treasuryAccountId: ROUTER_CONTRACT,
        supplyKey: { type: "ProtobufEncoded", key: contractKeyHex(7000) },
        ...token,
      },
    });
  const run = (w: ReturnType<typeof world>, config = routerConfig()) =>
    runHtsPreflight({ config, mirror: w.mirror, settlement: settlement() });

  it("passes when the router is the treasury and holds the supply key", async () => {
    const result = await run(routerWorld());
    expect(result.ok).toBe(true);
    expect(result.treasuryId).toBe(ROUTER_CONTRACT);
    expect(result.checks.find(c => c.id === "mint-permission")?.message).toContain(ROUTER_CONTRACT);
  });

  it("accepts a delegatable contract key too", async () => {
    expect(
      (await run(routerWorld({ supplyKey: { type: "ProtobufEncoded", key: contractKeyHex(7000, true) } }))).ok,
    ).toBe(true);
  });

  it("reports a router that is not deployed on this network as CONFIG_INVALID", async () => {
    const w = world({ contracts: {} });
    const failure = (await run({ ...w, mirror: { ...w.mirror, getContractId: async () => null } } as never)).failure;
    expect(failure).toMatchObject({ code: "CONFIG_INVALID" });
    expect(failure?.remediation).toMatch(/Deploy the router/);
  });

  it("a supply key held by another contract, or by a plain key, is NO_MINT_PERMISSION", async () => {
    const other = (await run(routerWorld({ supplyKey: { type: "ProtobufEncoded", key: contractKeyHex(8000) } })))
      .failure;
    expect(other).toMatchObject({ code: "NO_MINT_PERMISSION" });
    expect(other?.message).toContain("0.0.8000");
    expect((await run(routerWorld({ supplyKey: { type: "ED25519", key: OPERATOR_PUBLIC_KEY } }))).failure?.code).toBe(
      "NO_MINT_PERMISSION",
    );
  });

  it("the token's treasury must be the router", async () => {
    expect((await run(routerWorld({ treasuryAccountId: OPERATOR }))).failure).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("uses the configured router address to find the contract", async () => {
    const w = routerWorld();
    await run(w);
    expect(w.calls.mirror).toContain(`getContractId ${ROUTER_ADDRESS}`);
  });
});

describe("runHtsPreflight, pool-transfer", () => {
  const pool = (balance: bigint) => {
    const w = world({ token: { supplyKey: null } });
    w.setRelationship(OPERATOR, { balance });
    return w;
  };
  const run = (w: ReturnType<typeof world>) =>
    runHtsPreflight({ config: operatorConfig({ model: "pool-transfer" }), mirror: w.mirror, settlement: settlement() });

  it("needs no supply key (nothing is minted) but needs the pool to hold enough", async () => {
    const ok = await run(pool(1000n));
    expect(ok.ok).toBe(true);
    expect(ok.checks.some(c => c.id === "mint-permission")).toBe(false);
    const short = (await run(pool(999n))).failure;
    expect(short).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(short?.message).toMatch(/999/);
  });
});
