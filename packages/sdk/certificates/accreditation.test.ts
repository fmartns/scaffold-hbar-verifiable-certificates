import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { ACCREDITATION_REGISTRY_ABI } from "../generated/AccreditationRegistry";
import { InMemoryAccreditation } from "../testing/hedera";
import { MirrorAccreditationReader } from "./accreditation";

const abi = new Interface(ACCREDITATION_REGISTRY_ABI);
const ADDRESS = `0x${"00".repeat(16)}00a5b3c1`;
const DEFINITION = "did:hedera:testnet:z6Mk_0.0.10/anoncreds/v1/PUBLIC_CRED_DEF/0.0.12";

/** A Mirror Node `contracts/call` endpoint that answers from an in-memory registry, ABI-encoded like the EVM would. */
function mirrorFor(registry: InMemoryAccreditation) {
  const calls: { to: string; block: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://mirror.test/api/v1/contracts/call");
    const body = JSON.parse(String(init?.body));
    calls.push({ to: body.to, block: body.block });
    const call = abi.parseTransaction({ data: body.data })!;
    const value =
      call.name === "credentialDefinitions"
        ? await registry.credentialDefinitions(call.args[0])
        : await registry.isAccredited(call.args[0], call.args[1], Number(call.args[2]));
    return Response.json({ result: abi.encodeFunctionResult(call.name, [value]) });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("MirrorAccreditationReader", () => {
  it("reads accredited definitions and point-in-time accreditation through the Mirror Node", async () => {
    const registry = new InMemoryAccreditation();
    registry.accredit("Solidity Basics", DEFINITION);
    const { fetchImpl, calls } = mirrorFor(registry);
    const reader = new MirrorAccreditationReader("https://mirror.test/", ADDRESS, fetchImpl);

    expect(await reader.credentialDefinitions("Solidity Basics")).toEqual([DEFINITION]);
    expect(await reader.credentialDefinitions("Rust")).toEqual([]);
    const now = Math.floor(Date.now() / 1000);
    expect(await reader.isAccredited("Solidity Basics", DEFINITION, now)).toBe(true);
    expect(await reader.isAccredited("Solidity Basics", DEFINITION, now - 3600)).toBe(false);
    expect(calls.every(call => call.to === ADDRESS && call.block === "latest")).toBe(true);
  });

  it("reports an unreachable Mirror Node, an HTTP error and a malformed result as typed read failures", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const failing = (async () => new Response("", { status: 400 })) as typeof fetch;
    const garbage = (async () => Response.json({ result: "0x1234" })) as typeof fetch;
    for (const fetchImpl of [down, failing, garbage]) {
      await expect(
        new MirrorAccreditationReader("https://mirror.test", ADDRESS, fetchImpl).credentialDefinitions("x"),
      ).rejects.toMatchObject({ code: "LEDGER_READ_FAILED" });
    }
  });

  it("rejects an address that is not an EVM address", () => {
    expect(() => new MirrorAccreditationReader("https://mirror.test", "0.0.123")).toThrow(/Invalid contract address/);
  });
});
