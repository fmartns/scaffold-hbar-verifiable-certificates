import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * `@sh/sdk/hedera/wallet` is the only SDK entry client components may import. Walk its static import graph and fail
 * if anything reachable pulls in the Hedera SDK, Node built-ins or the environment loader.
 */
const FORBIDDEN = [/^@hiero-ledger\//, /^node:/, /^(fs|path|crypto|child_process|readline)$/];
const FORBIDDEN_LOCAL = [/\/environment$/, /\/hiero-transport$/, /\/server$/, /\/publisher$/];

function resolveLocal(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) if (existsSync(candidate)) return candidate;
  return null;
}

function walk(entry: string) {
  const seen = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const specifier = match[1];
      if (/^import\s+type\s/.test(match[0].trim())) continue;
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier);
        if (resolved) queue.push(resolved);
      } else {
        externals.add(specifier);
      }
    }
  }
  return { files: [...seen], externals: [...externals] };
}

describe("client entry (@sh/sdk/hedera/wallet)", () => {
  it("reaches the credential client helpers and nothing server-only", () => {
    const { files, externals } = walk(path.resolve(__dirname, "../wallet.ts"));
    expect(files.some(f => f.endsWith("credentials/issuer-flow.ts"))).toBe(true);
    expect(externals.filter(e => FORBIDDEN.some(p => p.test(e)))).toEqual([]);
    expect(
      files.map(f => f.replace(/\.ts$/, "").replace(/\/index$/, "")).filter(f => FORBIDDEN_LOCAL.some(p => p.test(f))),
    ).toEqual([]);
    expect(externals.sort()).toEqual(["ethers"]);
  });
});
