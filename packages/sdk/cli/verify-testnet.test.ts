import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ISSUER_SIGNER, fakeTestnet, inspectMatchingKey, testnetEnv } from "../testing";
import type { FakeTestnetOptions } from "../testing";
import { computeIssuerId } from "../hedera/credentials/schema";
import { VERIFY_TESTNET_DEFAULTS } from "../hedera/testnet/verification";
import { interpretAnswer, runVerifyTestnet, writeEvidence } from "./verify-testnet";
import type { VerifyTestnetOptions } from "./verify-testnet";

const ISSUER_ID = computeIssuerId(VERIFY_TESTNET_DEFAULTS.issuerName);

function options(net: FakeTestnetOptions = {}, extra: Partial<VerifyTestnetOptions> = {}) {
  const fake = fakeTestnet({ issuers: { [ISSUER_ID]: { signer: ISSUER_SIGNER.address } }, ...net });
  const opts: VerifyTestnetOptions = {
    fetch: fake.fetch,
    inspectKey: inspectMatchingKey,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    transport: fake.topic.transport,
    manifest: {},
    resolveIssuerKey: async () => ISSUER_SIGNER.privateKey,
    receiptPollMs: 10,
    ...extra,
  };
  return { fake, opts };
}

describe("yarn verify:testnet", () => {
  it("validates its flags before touching the network", async () => {
    const { fake, opts } = options();
    for (const [argv, text] of [
      [["--runs", "9"], "--runs must be an integer from 1 to 5"],
      [["--issuer", "Bad Name"], "--issuer must be 3-64 lowercase"],
      [["--json"], "--json needs --yes"],
    ] as const) {
      const result = await runVerifyTestnet([...argv], testnetEnv, opts);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join("\n")).toContain(text);
    }
    expect(fake.rpcCalls).toEqual([]);
  });

  it("refuses mainnet, in text and JSON", async () => {
    const { opts } = options();
    const env = { ...testnetEnv, HEDERA_NETWORK: "mainnet" };
    const text = await runVerifyTestnet([], env, opts);
    expect(text.exitCode).toBe(1);
    expect(text.lines.join("\n")).toContain("[MAINNET_REFUSED]");
    const json = await runVerifyTestnet(["--json", "--yes"], env, opts);
    expect(JSON.parse(json.lines[0])).toMatchObject({ ok: false, problem: { code: "MAINNET_REFUSED" } });
  });

  it("prints the environment report and exits 2 when nothing could be verified", async () => {
    const { opts } = options({ downMethods: ["eth_call"] });
    const result = await runVerifyTestnet(["--yes"], testnetEnv, opts);
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toContain("[REGISTRY_UNREADABLE]");

    const invalid = await runVerifyTestnet(["--yes"], { ...testnetEnv, HEDERA_OPERATOR_ID: "" }, opts);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.lines.join("\n")).toContain("HEDERA_OPERATOR_ID");
  });

  it("shows the plan and cost on --dry-run and sends nothing", async () => {
    const { fake, opts } = options();
    const result = await runVerifyTestnet(["--dry-run", "--runs", "1"], testnetEnv, opts);
    const text = result.lines.join("\n");
    expect(result.exitCode).toBe(0);
    expect(text).toContain("Validate the credential flow on Hedera Testnet");
    expect(text).toContain("issue()               1 × ≤ 350000 gas");
    expect(text).toContain("Total                 ≤");
    expect(text).toContain("Dry run: nothing was sent, paid or written.");
    expect(fake.transactions).toEqual([]);
    expect(fake.world.messages).toEqual([]);

    const json = await runVerifyTestnet(["--dry-run", "--json"], testnetEnv, opts);
    expect(JSON.parse(json.lines[0])).toMatchObject({ ok: true, plan: { runs: 2, network: "testnet" } });
    expect(json.lines[0]).not.toContain(testnetEnv.HEDERA_OPERATOR_KEY);
  });

  it("explains a plan whose total is unknown and a namespace it will register", async () => {
    const { opts } = options({ usdPerHbar: null, issuers: {}, admin: ISSUER_SIGNER.address });
    const text = (await runVerifyTestnet(["--dry-run"], testnetEnv, opts)).lines.join("\n");
    expect(text).toContain("0. Register the issuer namespace once");
    expect(text).toContain("Total                 unknown");
  });

  it("refuses when the balance does not cover the estimate", async () => {
    const { fake, opts } = options({ balanceTinybars: 20_000_000n });
    const result = await runVerifyTestnet(["--yes"], { ...testnetEnv, HEDERA_MIN_BALANCE_HBAR: "0.1" }, opts);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("[INSUFFICIENT_BALANCE]");
    expect(fake.transactions).toEqual([]);
  });

  it("pays nothing without a terminal or --yes, and nothing when the person says no", async () => {
    const { fake, opts } = options();
    const headless = await runVerifyTestnet([], testnetEnv, opts);
    expect(headless.exitCode).toBe(1);
    expect(headless.lines.join("\n")).toContain("Not running in an interactive terminal");

    let shown: string[] = [];
    const cancelled = await runVerifyTestnet([], testnetEnv, {
      ...opts,
      confirm: async lines => {
        shown = lines;
        return false;
      },
    });
    expect(shown.join("\n")).toContain("Estimated cost, paid by the operator account");
    expect(cancelled.lines.join("\n")).toContain("Cancelled. Nothing was sent and nothing was charged.");
    expect(fake.world.messages).toEqual([]);
  });

  it("runs after the person agrees, streams progress and points to the evidence", async () => {
    const progress: string[] = [];
    const { fake, opts } = options({}, { confirm: async () => true, progress: line => progress.push(line) });
    const result = await runVerifyTestnet(["--runs", "1"], testnetEnv, opts);
    const text = result.lines.join("\n");
    expect(result.exitCode).toBe(0);
    expect(text).toContain("1 run(s) passed");
    expect(text).toContain("HCS       https://hashscan.io/testnet/transaction/");
    expect(text).toContain(
      "Evidence: docs/evidence/testnet/20261001T120000Z.md and docs/evidence/testnet/20261001T120000Z.json",
    );
    expect(text).not.toContain("Estimated cost");
    expect(progress[0]).toBe("Run 1/1: credential VERIFY-20261001T120000Z-1");
    expect(fake.transactions.map(t => t.method)).toEqual(["issue", "revoke"]);
  });

  it("includes the plan with --yes, prints JSON with --json, and exits 1 on a failed run", async () => {
    const yes = await runVerifyTestnet(["--yes", "--runs", "1"], testnetEnv, options().opts);
    expect(yes.lines.join("\n")).toContain("Estimated cost, paid by the operator account");

    const json = await runVerifyTestnet(["--yes", "--json", "--runs", "1"], testnetEnv, options().opts);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.lines[0])).toMatchObject({ ok: true, kind: "testnet-credential-validation" });

    const { fake, opts } = options();
    fake.topic.failNext(new Error("INSUFFICIENT_PAYER_BALANCE"));
    const failed = await runVerifyTestnet(["--yes", "--runs", "1"], testnetEnv, opts);
    expect(failed.exitCode).toBe(1);
    expect(failed.lines.join("\n")).toContain("Run 1  failed at issuance");
  });

  it("writes the Markdown and JSON evidence", async () => {
    const result = await runVerifyTestnet(["--yes", "--runs", "1"], testnetEnv, options().opts);
    const root = mkdtempSync(path.join(tmpdir(), "verify-testnet-"));
    try {
      const written = writeEvidence(root, result.report!);
      expect(written).toEqual([
        "docs/evidence/testnet/20261001T120000Z.md",
        "docs/evidence/testnet/20261001T120000Z.json",
      ]);
      for (const file of written) expect(existsSync(path.join(root, file))).toBe(true);
      expect(readFileSync(path.join(root, written[0]), "utf8")).toContain("✅ passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the confirmation answer: Enter means yes", () => {
    for (const yes of ["", "y", "YES", " yes "]) expect(interpretAnswer(yes)).toBe(true);
    for (const no of ["n", "no", "later"]) expect(interpretAnswer(no)).toBe(false);
  });
});
