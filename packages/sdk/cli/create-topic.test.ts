import { describe, expect, it } from "vitest";
import { formatPlan, interpretAnswer, planEnvWrite, runCreateTopic, upsertEnvLine } from "./create-topic";
import { EXIT } from "./setup";
import { buildCostEstimate } from "../hedera/hcs/cost";
import { NETWORKS } from "../hedera/networks";
import type { TopicCreator } from "../hedera/hcs/topic-create";
import { TEST_ROUTER, TEST_SIGNER, fakeTransport, goodReceipt } from "../hedera/hcs/test-fixtures";

const PUBLIC_KEY = "ab".repeat(32);
const env = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: "0.0.1234", HEDERA_OPERATOR_KEY: "ef".repeat(32) };
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: PUBLIC_KEY }];
const TX = "0.0.1234@1767225600.123456789";

/** Mirror Node: the account, the topic (and published messages), the exchange rate and the charged fee. */
function fakeMirror(sent: { message?: Uint8Array } = {}) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/v1/accounts/")) {
      return new Response(
        `{"account":"0.0.1234","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${PUBLIC_KEY}"}}`,
      );
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      return new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }));
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return new Response(JSON.stringify({ transactions: [{ charged_tx_fee: 25_631_823 }] }));
    }
    if (url.pathname.includes("/messages/")) {
      return sent.message
        ? new Response(JSON.stringify({ message: Buffer.from(sent.message).toString("base64") }))
        : new Response("", { status: 404 });
    }
    return new Response(
      JSON.stringify({
        topic_id: "0.0.8888",
        memo: "",
        deleted: false,
        submit_key: { _type: "ED25519", key: PUBLIC_KEY },
      }),
    );
  }) as typeof fetch;
}

const created: unknown[] = [];
const creator: TopicCreator = {
  create: async request => (created.push(request), { topicId: "0.0.8888", transactionId: TX }),
};
const baseOptions = { fetch: fakeMirror(), inspectKey, creator, sleep: async () => undefined };
const text = (r: { lines: string[] }) => r.lines.join("\n");

describe("the plan and the question", () => {
  it("shows what will be created and what it may cost, then asks, then creates", async () => {
    created.length = 0;
    let shown = "";
    const result = await runCreateTopic([], env, {
      ...baseOptions,
      confirm: async lines => {
        expect(created).toHaveLength(0); // nothing is paid for before the answer
        shown = lines.join("\n");
        return true;
      },
    });
    expect(shown).toContain("What will be created");
    expect(shown).toContain("only your operator key");
    expect(shown).toContain("No admin key");
    expect(shown).toContain("Create the topic      about $0.02 (~0.2595 HBAR)");
    expect(shown).toContain("Exchange rate         $0.0771 per HBAR");
    expect(shown).toContain("Testnet HBAR has no monetary value");
    expect(result.exitCode).toBe(EXIT.OK);
    expect(created).toHaveLength(1);
    expect(text(result)).toContain("charged 0.25631823 HBAR (about $0.02)");
  });

  it("creates nothing and says so when the answer is no", async () => {
    created.length = 0;
    const result = await runCreateTopic([], env, { ...baseOptions, confirm: async () => false });
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("Cancelled. Nothing was created and nothing was charged.");
    expect(created).toHaveLength(0);
  });

  it("refuses to create without a terminal and without --yes, but still shows the cost", async () => {
    created.length = 0;
    const result = await runCreateTopic([], env, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    const out = text(result);
    expect(out).toContain("Not running in an interactive terminal");
    expect(out).toContain("pass --yes");
    expect(out).toContain("Estimated cost");
    expect(created).toHaveLength(0);
  });

  it("with --yes does not ask, and puts the plan in the output", async () => {
    created.length = 0;
    const result = await runCreateTopic(["--yes"], env, baseOptions);
    const out = text(result);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(out).toContain("What will be created");
    expect(out).toContain("Created topic 0.0.8888 on testnet");
    expect(created).toHaveLength(1);
  });
});

describe("the result explains what was created", () => {
  it("lists id, who can write and read, admin key, cost, HashScan and the .env line", async () => {
    const out = text(await runCreateTopic(["-y"], env, baseOptions));
    for (const expected of [
      "Topic ID      0.0.8888",
      `Transaction   ${TX}`,
      "Can write     only your operator key",
      "Can read      anyone",
      "Admin key     none: permanent",
      "Cost          charged 0.25631823 HBAR",
      "HashScan      https://hashscan.io/testnet/topic/0.0.8888",
      "Set in .env: HEDERA_HCS_TOPIC_ID=0.0.8888",
      "yarn hcs:topic --smoke-test",
    ]) {
      expect(out).toContain(expected);
    }
  });

  it("says nothing was created or charged when a usable topic is already configured, and does not ask", async () => {
    created.length = 0;
    let asked = 0;
    const result = await runCreateTopic(
      [],
      { ...env, HEDERA_HCS_TOPIC_ID: "0.0.8888" },
      { ...baseOptions, confirm: async () => (asked++, true) },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(text(result)).toContain("nothing was created and nothing was charged");
    expect(asked).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("explains an admin key and passes --memo, --with-admin-key through", async () => {
    created.length = 0;
    const result = await runCreateTopic(["--yes", "--memo", "hello", "--with-admin-key"], env, baseOptions);
    expect(created[0]).toMatchObject({ memo: "hello", withAdminKey: true });
    expect(text(result)).toContain("Admin key: your operator key, so the topic can be edited or deleted");
  });

  it("never prints the operator key", async () => {
    expect(text(await runCreateTopic(["--yes"], env, baseOptions))).not.toContain("efefef");
  });
});

describe("failures", () => {
  it("exits 1 with the same environment report as `yarn setup` when the environment is invalid", async () => {
    const result = await runCreateTopic(["--yes"], {}, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("[MISSING_ENV] HEDERA_OPERATOR_ID");
  });

  it("exits 2 when the network cannot be reached", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    expect((await runCreateTopic(["--yes"], env, { ...baseOptions, fetch: down })).exitCode).toBe(EXIT.UNVERIFIED);
  });

  it("refuses mainnet without --allow-mainnet", async () => {
    const result = await runCreateTopic(["--yes"], { ...env, HEDERA_NETWORK: "mainnet" }, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("--allow-mainnet");
  });
});

describe("--smoke-test", () => {
  function smokeOptions(opts: { failPublish?: boolean; unreadable?: boolean } = {}) {
    const sent: { message?: Uint8Array } = {};
    const { transport } = fakeTransport(request => {
      if (opts.failPublish)
        throw Object.assign(new Error("x"), { name: "PrecheckStatusError", status: "INVALID_TOPIC_ID" });
      sent.message = opts.unreadable ? undefined : request.message;
      return goodReceipt();
    });
    return {
      ...baseOptions,
      fetch: fakeMirror(sent),
      smokeTest: { transport, signer: TEST_SIGNER, sleep: async () => undefined, readAttempts: 2, readDelayMs: 0 },
    };
  }
  const smokeEnv = { ...env, HEDERA_SETTLEMENT_ROUTER_ADDRESS: TEST_ROUTER };

  it("publishes and reads back after creating the topic, and reports both", async () => {
    const result = await runCreateTopic(["--yes", "--smoke-test"], smokeEnv, smokeOptions());
    const out = text(result);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.smokeTest).toMatchObject({ ok: true });
    expect(out).toContain("Smoke test: publish one message and read it back");
    expect(out).toContain("Read it back from Mirror Node");
    expect(out).toContain("digest and signer match");
    expect(out).toContain("throwaway attestation");
    expect(out).not.toContain("yarn hcs:topic --smoke-test");
  });

  it("runs on an existing topic too, without creating anything", async () => {
    created.length = 0;
    const result = await runCreateTopic(
      ["--smoke-test"],
      { ...smokeEnv, HEDERA_HCS_TOPIC_ID: "0.0.8888" },
      smokeOptions(),
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(created).toHaveLength(0);
    expect(result.smokeTest).toMatchObject({ ok: true });
  });

  it("does not run when the topic was not created (cancelled)", async () => {
    const result = await runCreateTopic(["--smoke-test"], smokeEnv, { ...smokeOptions(), confirm: async () => false });
    expect(result.smokeTest).toBeUndefined();
  });

  it("exits 1 and explains a failed publish", async () => {
    const result = await runCreateTopic(["--yes", "--smoke-test"], smokeEnv, smokeOptions({ failPublish: true }));
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("[TOPIC_INVALID]");
  });

  it("exits 1 when the message cannot be read back, but says it was published", async () => {
    const result = await runCreateTopic(["--yes", "--smoke-test"], smokeEnv, smokeOptions({ unreadable: true }));
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("was published but Mirror Node did not return it");
  });

  it("puts the smoke test in the --json output", async () => {
    const result = await runCreateTopic(["--yes", "--smoke-test", "--json"], smokeEnv, smokeOptions());
    expect(JSON.parse(result.lines[0])).toMatchObject({ ok: true, topicId: "0.0.8888", smokeTest: { ok: true } });
  });
});

describe("--json", () => {
  it("prints machine-readable JSON and keeps the exit codes", async () => {
    const result = await runCreateTopic(["--yes", "--json"], env, baseOptions);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.lines[0])).toMatchObject({
      ok: true,
      topicId: "0.0.8888",
      envLine: "HEDERA_HCS_TOPIC_ID=0.0.8888",
    });
  });
});

describe("formatPlan", () => {
  const plan = (network: keyof typeof NETWORKS, extra = {}) => ({
    network,
    chainId: NETWORKS[network].chainId,
    operatorId: "0.0.1234",
    balance: { tinybars: "1", hbar: "1000" },
    memo: "m",
    withAdminKey: false,
    cost: buildCostEstimate(NETWORKS[network], null),
    ...extra,
  });

  it("warns that mainnet is real money and that the topic is permanent", () => {
    const out = formatPlan(plan("mainnet"), false).join("\n");
    expect(out).toContain("This is MAINNET: these are real charges");
    expect(out).not.toContain("no monetary value");
  });

  it("shows USD only when the rate is unknown, and mentions the smoke test cost only when asked", () => {
    const out = formatPlan(plan("testnet"), true).join("\n");
    expect(out).toContain("Create the topic      about $0.02\n");
    expect(out).not.toContain("Exchange rate");
    expect(out).toContain("With --smoke-test     one message is published now: about $0.0005 more");
    expect(out).toContain("--smoke-test");
    expect(formatPlan(plan("testnet"), false).join("\n")).not.toContain("--smoke-test");
  });
});

describe("planEnvWrite (--write)", () => {
  it("writes the new topic id into an existing .env", async () => {
    const result = await runCreateTopic(["--yes"], env, baseOptions);
    expect(planEnvWrite(result.result, true)).toEqual({
      write: true,
      key: "HEDERA_HCS_TOPIC_ID",
      value: "0.0.8888",
      message: "Updated .env.",
    });
  });

  it("says there is no .env to update instead of creating one", async () => {
    const result = await runCreateTopic(["--yes"], env, baseOptions);
    expect(planEnvWrite(result.result, false)).toMatchObject({
      write: false,
      message: expect.stringContaining("No .env file"),
    });
  });

  it("explains that nothing is written when the topic was already configured", async () => {
    const result = await runCreateTopic([], { ...env, HEDERA_HCS_TOPIC_ID: "0.0.8888" }, baseOptions);
    expect(planEnvWrite(result.result, true)).toEqual({
      write: false,
      message: "Nothing to write: HEDERA_HCS_TOPIC_ID is already set to this topic.",
    });
  });

  it("stays silent after a failure", async () => {
    const result = await runCreateTopic(["--yes"], {}, baseOptions);
    expect(planEnvWrite(result.result, true)).toEqual({ write: false, message: null });
  });
});

describe("interpretAnswer", () => {
  it("on testnet and local, Enter, y and yes agree; anything else declines", () => {
    for (const yes of ["", "  ", "y", "Y", "yes", "YES"]) expect(interpretAnswer(yes, false)).toBe(true);
    for (const no of ["n", "N", "no", "nope", "sim?"]) expect(interpretAnswer(no, false)).toBe(false);
  });

  it("on mainnet only the word yes agrees, never Enter or y", () => {
    expect(interpretAnswer("yes", true)).toBe(true);
    for (const no of ["", "y", "Y", "n", "ok"]) expect(interpretAnswer(no, true)).toBe(false);
  });
});

describe("upsertEnvLine", () => {
  it("replaces an empty or filled line and touches nothing else", () => {
    expect(upsertEnvLine("A=1\nHEDERA_HCS_TOPIC_ID=\nB=2\n", "HEDERA_HCS_TOPIC_ID", "0.0.5")).toBe(
      "A=1\nHEDERA_HCS_TOPIC_ID=0.0.5\nB=2\n",
    );
    expect(upsertEnvLine("HEDERA_HCS_TOPIC_ID=0.0.1\n", "HEDERA_HCS_TOPIC_ID", "0.0.5")).toBe(
      "HEDERA_HCS_TOPIC_ID=0.0.5\n",
    );
  });

  it("appends when the variable is absent, with or without a trailing newline", () => {
    expect(upsertEnvLine("A=1\n", "K", "v")).toBe("A=1\nK=v\n");
    expect(upsertEnvLine("A=1", "K", "v")).toBe("A=1\nK=v\n");
    expect(upsertEnvLine("", "K", "v")).toBe("K=v\n");
  });

  it("does not match a variable that merely starts with the same name", () => {
    expect(upsertEnvLine("XK=1\n", "K", "v")).toBe("XK=1\nK=v\n");
  });
});
