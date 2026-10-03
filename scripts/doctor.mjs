#!/usr/bin/env node
// Verifies the local toolchain before any workspace command runs. Exits 1 on a blocking problem.
// Diagnostics go to stderr so that commands which chain it (yarn setup --json) keep a clean stdout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const minNode = String(pkg.engines?.node ?? "").replace(/^>=\s*/, "");

const parse = v => v.split(".").map(n => Number.parseInt(n, 10) || 0);
const atLeast = (actual, minimum) => {
  const [a, m] = [parse(actual), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (m[i] ?? 0)) return (a[i] ?? 0) > (m[i] ?? 0);
  }
  return true;
};

console.error("Environment check");
const problems = [];
const warnings = [];
const ok = message => console.error(`  ok    ${message}`);

if (!minNode) {
  problems.push('package.json has no "engines.node"; the minimum Node.js version is undefined.');
} else if (atLeast(process.versions.node, minNode)) {
  ok(`Node.js ${process.versions.node} (>= ${minNode})`);
} else {
  problems.push(`Node.js ${process.versions.node} is older than the required >= ${minNode}.`);
}

try {
  const yarn = execFileSync("yarn", ["--version"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // Windows resolves `yarn` to `yarn.cmd`, which is only found through a shell.
    shell: process.platform === "win32",
  }).trim();
  ok(`Yarn ${yarn}`);
} catch {
  problems.push("Yarn was not found on PATH. Run `corepack enable` (bundled with Node.js) or install Yarn.");
}

if (existsSync(path.join(root, ".env"))) {
  ok(".env present");
} else {
  warnings.push("No .env file. Run `cp .env.example .env` and fill in what you need; the app defaults to testnet.");
}

for (const w of warnings) console.error(`  warn  ${w}`);
for (const p of problems) console.error(`  FAIL  ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
