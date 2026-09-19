import { describe, expect, it } from "vitest";
import { EXIT, runSetup } from "./setup";

const ACCOUNT = "0.0.1234";
const PUBLIC_KEY = "ab".repeat(32);
const env = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: ACCOUNT, HEDERA_OPERATOR_KEY: "cd".repeat(32) };
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: PUBLIC_KEY }];

const answer = (status: number, body = "") => (async () => new Response(body, { status })) as typeof fetch;
const okAccount = `{"account":"${ACCOUNT}","deleted":false,"balance":{"balance":5000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${PUBLIC_KEY}"}}`;

describe("runSetup", () => {
  it("exits 0 and shows account, network and HashScan link for a valid environment", async () => {
    const { exitCode, lines } = await runSetup([], env, { fetch: answer(200, okAccount), inspectKey });
    const text = lines.join("\n");
    expect(exitCode).toBe(EXIT.OK);
    expect(text).toContain(ACCOUNT);
    expect(text).toContain("https://hashscan.io/testnet/account/0.0.1234");
    expect(text).toContain("Environment validated");
  });

  it("stops before the Hedera-dependent steps and exits 1 when the environment is invalid", async () => {
    const { exitCode, lines } = await runSetup([], {}, { fetch: answer(200, okAccount) });
    const text = lines.join("\n");
    expect(exitCode).toBe(EXIT.INVALID);
    expect(text).toContain("[MISSING_ENV] HEDERA_OPERATOR_ID");
    expect(text).not.toContain("Environment validated");
  });

  it("exits 2, not 1, when the network cannot be reached", async () => {
    const { exitCode } = await runSetup([], env, { fetch: answer(503), inspectKey });
    expect(exitCode).toBe(EXIT.UNVERIFIED);
  });

  it("prints machine-readable JSON with --json and keeps the same exit codes", async () => {
    const valid = await runSetup(["--json"], env, { fetch: answer(200, okAccount), inspectKey });
    expect(valid.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(valid.lines[0])).toMatchObject({ ok: true, network: "testnet", accountId: ACCOUNT });

    const invalid = await runSetup(["--json"], {}, {});
    expect(invalid.exitCode).toBe(EXIT.INVALID);
    expect(JSON.parse(invalid.lines[0]).issues[0].code).toBe("MISSING_ENV");
  });
});
