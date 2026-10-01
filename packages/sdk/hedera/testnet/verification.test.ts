import { describe, expect, it } from "vitest";
import {
  ADMIN,
  ISSUER_SIGNER,
  REGISTRY,
  STRANGER,
  TOPIC,
  fakeTestnet,
  inspectMatchingKey,
  testnetEnv,
} from "../../testing";
import type { FakeTestnetOptions } from "../../testing";
import { computeIssuerId } from "../credentials/schema";
import { IssuerKeyError } from "./issuer-key";
import {
  ESTIMATED_GAS,
  VERIFY_TESTNET_DEFAULTS,
  balanceCovers,
  estimateVerificationCost,
  isValidIssuerName,
  parseRuns,
  planVerification,
  runIdOf,
  runVerification,
  verificationDraftInput,
} from "./verification";
import type { VerifyDeps } from "./verification";

const ISSUER_ID = computeIssuerId(VERIFY_TESTNET_DEFAULTS.issuerName);
const registered = { [ISSUER_ID]: { signer: ISSUER_SIGNER.address } };

function setup(options: FakeTestnetOptions = {}, deps: Partial<VerifyDeps> = {}) {
  const net = fakeTestnet({ issuers: registered, ...options });
  const all: VerifyDeps = {
    fetch: net.fetch,
    inspectKey: inspectMatchingKey,
    now: net.clock.now,
    sleep: net.clock.sleep,
    transport: net.topic.transport,
    manifest: {},
    resolveIssuerKey: async () => ISSUER_SIGNER.privateKey,
    receiptPollMs: 10,
    auditRetryMs: 1_000,
    ...deps,
  };
  return { net, deps: all };
}

async function planned(options: FakeTestnetOptions = {}, deps: Partial<VerifyDeps> = {}, runs = 2) {
  const { net, deps: all } = setup(options, deps);
  const plan = await planVerification(testnetEnv, { ...all, runs });
  if (!plan.ok) throw new Error(`plan failed: ${plan.problem.code}`);
  return { net, deps: all, plan };
}

describe("planVerification", () => {
  it("plans two runs on Testnet with the registered issuer and an estimated cost", async () => {
    const { plan } = await planned();
    expect(plan.plan).toMatchObject({
      network: "testnet",
      chainId: 296,
      operatorId: testnetEnv.HEDERA_OPERATOR_ID,
      registry: { address: REGISTRY, source: "override" },
      topic: { id: TOPIC },
      issuer: { name: "scaffold-hbar-verify", signer: ISSUER_SIGNER.address.toLowerCase(), register: false },
      runs: 2,
    });
    expect(plan.plan.cost.hcsMessages).toBe(4);
    expect(plan.plan.cost.totalHbar).not.toBeNull();
    expect(balanceCovers(plan.plan)).toBe(true);
    expect(JSON.stringify(plan.plan)).not.toContain(testnetEnv.HEDERA_OPERATOR_KEY);
  });

  it("refuses mainnet and local before reading anything", async () => {
    const { net, deps } = setup();
    for (const [network, code] of [
      ["mainnet", "MAINNET_REFUSED"],
      ["local", "NOT_TESTNET"],
    ]) {
      const plan = await planVerification({ ...testnetEnv, HEDERA_NETWORK: network }, deps);
      expect(plan).toMatchObject({ ok: false, status: "invalid", problem: { code } });
    }
    expect(net.rpcCalls).toEqual([]);
    expect(net.mirrorCalls).toEqual([]);
  });

  it("stops on an invalid environment with the validation report", async () => {
    const { deps } = setup();
    const plan = await planVerification({ ...testnetEnv, HEDERA_OPERATOR_ID: "" }, deps);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.environment?.ok).toBe(false);
    expect(plan.problem.code).toBe("MISSING_ENV");
    expect(plan.problem.message).toContain("HEDERA_OPERATOR_ID");
  });

  it("uses the generated manifest when no address is configured, and explains a missing deployment", async () => {
    const manifestAddress = REGISTRY;
    const { deps } = setup();
    const env = { ...testnetEnv, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: "" };
    const fromManifest = await planVerification(env, {
      ...deps,
      manifest: {
        testnet: {
          CredentialRegistry: {
            address: manifestAddress,
            contractId: "0.0.9001",
            deployTxHash: null,
            blockNumber: null,
            abiHash: "0x00",
          },
        },
      },
    });
    expect(fromManifest.ok && fromManifest.plan.registry).toMatchObject({ source: "manifest", contractId: "0.0.9001" });

    const missing = await planVerification(env, deps);
    expect(missing).toMatchObject({ ok: false, problem: { code: "REGISTRY_NOT_DEPLOYED" } });
    if (!missing.ok) expect(missing.problem.remediation).toContain("yarn deploy --network hederaTestnet");

    const invalid = await planVerification({ ...testnetEnv, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: "0x1234" }, deps);
    expect(invalid).toMatchObject({ ok: false, problem: { code: "REGISTRY_ADDRESS_INVALID" } });
  });

  it("points to yarn hcs:topic when the topic is not configured", async () => {
    const { deps } = setup();
    const plan = await planVerification({ ...testnetEnv, HEDERA_HCS_TOPIC_ID: "" }, deps);
    expect(plan).toMatchObject({ ok: false, problem: { code: "TOPIC_NOT_CONFIGURED" } });
    if (!plan.ok) expect(plan.problem.remediation).toContain("yarn hcs:topic --write");

    const timeout = await planVerification({ ...testnetEnv, HEDERA_HCS_PUBLISH_TIMEOUT_MS: "5" }, deps);
    expect(timeout).toMatchObject({ ok: false, problem: { code: "NOT_CONFIGURED" } });
  });

  it("refuses an operator key that has no EVM address, or that cannot be resolved", async () => {
    const notEcdsa = setup(
      {},
      {
        resolveIssuerKey: async () => {
          throw new IssuerKeyError("ISSUER_KEY_NOT_ECDSA", "ED25519", "Use ECDSA.");
        },
      },
    );
    expect(await planVerification(testnetEnv, notEcdsa.deps)).toMatchObject({
      ok: false,
      problem: { code: "ISSUER_KEY_NOT_ECDSA" },
    });
    const broken = setup(
      {},
      {
        resolveIssuerKey: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(await planVerification(testnetEnv, broken.deps)).toMatchObject({
      ok: false,
      problem: { code: "ISSUER_KEY_UNRESOLVED" },
    });
  });

  it("plans the registration when the namespace is free and the operator is admin, and refuses otherwise", async () => {
    const asAdmin = setup({ issuers: {}, admin: ISSUER_SIGNER.address });
    const plan = await planVerification(testnetEnv, asAdmin.deps);
    expect(plan.ok && plan.plan.issuer.register).toBe(true);
    expect(plan.ok && plan.plan.cost.contractCalls[0]).toMatchObject({ call: "registerIssuer", count: 1 });

    const notAdmin = setup({ issuers: {}, admin: ADMIN.address });
    expect(await planVerification(testnetEnv, notAdmin.deps)).toMatchObject({
      ok: false,
      problem: { code: "ISSUER_NOT_REGISTERED" },
    });
  });

  it("refuses a namespace with another signer, inactive or with a too short window", async () => {
    for (const [cfg, code] of [
      [{ signer: STRANGER.address }, "ISSUER_SIGNER_MISMATCH"],
      [{ signer: ISSUER_SIGNER.address, active: false }, "ISSUER_INACTIVE"],
      [{ signer: ISSUER_SIGNER.address, maxValidity: 60n }, "ISSUER_MAX_VALIDITY_TOO_SHORT"],
    ] as const) {
      const { deps } = setup({ issuers: { [ISSUER_ID]: cfg } });
      expect(await planVerification(testnetEnv, deps)).toMatchObject({ ok: false, problem: { code } });
    }
  });

  it("reports an unreadable registry as unverified", async () => {
    const { deps } = setup({ downMethods: ["eth_call"] });
    expect(await planVerification(testnetEnv, deps)).toMatchObject({
      ok: false,
      status: "unverified",
      problem: { code: "REGISTRY_UNREADABLE" },
    });
  });

  it("leaves the total unknown without a gas price or exchange rate", async () => {
    const { plan } = await planned({ usdPerHbar: null, downMethods: ["eth_gasPrice"] });
    expect(plan.plan.cost).toMatchObject({ totalHbar: null, totalUsd: null, gasPriceWeibars: null });
    expect(balanceCovers(plan.plan)).toBeNull();
  });
});

describe("runVerification", () => {
  it("issues, audits, refuses re-issuance, revokes and audits again, twice, with HCS evidence first", async () => {
    const { net, deps, plan } = await planned();
    const progress: string[] = [];
    const result = await runVerification(plan.plan, plan.session, deps, line => progress.push(line));

    expect(result.ok).toBe(true);
    expect(result.registration).toBeNull();
    expect(result.runs).toHaveLength(2);
    for (const run of result.runs) {
      expect(run.ok).toBe(true);
      expect(run.issuance!.hcs.hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\//);
      expect(run.issuance!.registry.mirrorUrl).toContain("/api/v1/contracts/results/0x");
      expect(run.auditAfterIssuance).toMatchObject({ ok: true, evidence: "consistent", onChainStatus: "issued" });
      expect(run.auditAfterRevocation).toMatchObject({
        ok: true,
        evidence: "consistent",
        onChainStatus: "revoked",
        issuanceMatched: true,
        revocationMatched: true,
      });
      expect(run.blockedAttempts.map(a => [a.attempt, a.code, a.blocked, a.nothingPaid])).toEqual([
        ["replay_signed_issuance", "AlreadyIssued", true, true],
        ["reissue_same_reference", "ConflictingCredential", true, true],
        ["revoke_again", "AlreadyRevoked", true, true],
      ]);
      expect(Object.keys(run.issuance!.steps)).toEqual(["build", "sign", "simulate", "publish", "register", "confirm"]);
    }
    // Two HCS messages and two registry transactions per run, each HCS message before its transaction (D11).
    expect(net.world.messages).toHaveLength(4);
    expect(net.transactions.map(t => [t.method, t.status])).toEqual([
      ["issue", "0x1"],
      ["revoke", "0x1"],
      ["issue", "0x1"],
      ["revoke", "0x1"],
    ]);
    expect(progress.some(line => line.includes("blocked reissue_same_reference: ConflictingCredential"))).toBe(true);
  });

  it("registers the namespace first when planned", async () => {
    const { net, deps, plan } = await planned({ issuers: {}, admin: ISSUER_SIGNER.address }, {}, 1);
    const result = await runVerification(plan.plan, plan.session, deps);
    expect(result.ok).toBe(true);
    expect(result.registration?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(net.transactions[0]).toMatchObject({ method: "registerIssuer", status: "0x1" });
  });

  it("stops when the registration is refused", async () => {
    const { net, deps, plan } = await planned({ issuers: {}, admin: ISSUER_SIGNER.address }, {}, 1);
    net.issuers.set(ISSUER_ID, { signer: STRANGER.address.toLowerCase(), active: true, maxValidity: 900n });
    const result = await runVerification(plan.plan, plan.session, deps);
    expect(result).toMatchObject({
      ok: false,
      runs: [],
      registrationFailure: { category: "contract_rejected", code: "IssuerAlreadyRegistered" },
    });
    expect(net.world.messages).toHaveLength(0);
  });

  it("waits for the Mirror Node to index (pending_index) inside the budget", async () => {
    const { deps, plan } = await planned({ mirrorLagReads: 2 }, {}, 1);
    const result = await runVerification(plan.plan, plan.session, deps);
    expect(result.ok).toBe(true);
    expect(result.runs[0].auditAfterIssuance!.evidence).toBe("consistent");
  });

  it("fails the run, with the stage and identifiers, when the HCS publication fails", async () => {
    const { net, deps, plan } = await planned({}, {}, 2);
    net.topic.failNext(
      Object.assign(new Error("INSUFFICIENT_PAYER_BALANCE"), { status: "INSUFFICIENT_PAYER_BALANCE" }),
    );
    const result = await runVerification(plan.plan, plan.session, deps);
    expect(result.ok).toBe(false);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].failure?.stage).toBe("issuance");
    expect(net.transactions).toHaveLength(0);
  });

  it("fails when the audit never becomes consistent within the budget", async () => {
    const { deps, plan } = await planned({ mirrorLagReads: 10_000 }, { indexBudgetSeconds: 5 }, 1);
    const result = await runVerification(plan.plan, plan.session, deps);
    expect(result.ok).toBe(false);
    expect(result.runs[0].auditAfterIssuance!.ok).toBe(false);
    expect(result.runs[0].auditAfterIssuance!.evidence).not.toBe("consistent");
  });
});

describe("helpers", () => {
  it("parses --runs and the issuer namespace", () => {
    expect(parseRuns(undefined)).toBe(2);
    expect(parseRuns("1")).toBe(1);
    expect(parseRuns("5")).toBe(5);
    for (const bad of ["0", "6", "two", "1.5"]) expect(parseRuns(bad)).toBeNull();
    expect(isValidIssuerName("scaffold-hbar-verify")).toBe(true);
    for (const bad of ["ab", "Upper", "-dash", "has space"]) expect(isValidIssuerName(bad)).toBe(false);
  });

  it("estimates the cost from the gas bounds, the gas price and the exchange rate", () => {
    const cost = estimateVerificationCost(1, false, 10_000_000_000n, 0.1);
    const gas = ESTIMATED_GAS.issue + ESTIMATED_GAS.revoke;
    expect(cost.contractCalls.map(c => c.call)).toEqual(["issue", "revoke"]);
    // gas × 1 tinybar + 2 × $0.0005 at $0.1 per HBAR (0.01 HBAR).
    expect(gas).toBe(450_000n);
    expect(cost.totalHbar).toBe("0.0145");
    expect(cost.usdPerHbar).toBe("0.1000");
  });

  it("derives a unique, valid draft per run", () => {
    const now = Date.UTC(2026, 9, 1, 12, 34, 56);
    expect(runIdOf(now)).toBe("20261001T123456Z");
    const draft = verificationDraftInput("scaffold-hbar-verify", runIdOf(now), 2, now);
    expect(draft).toMatchObject({
      reference: "VERIFY-20261001T123456Z-2",
      subjectIdValue: "holder.20261001t123456z.2@example.com",
      issuedOn: "2026-10-01",
      validitySeconds: VERIFY_TESTNET_DEFAULTS.validitySeconds,
    });
  });
});
