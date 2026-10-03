#!/usr/bin/env node
// End-to-end check of the create-scaffold-hbar flow in a clean directory.
//
//   node scripts/verify-scaffold.mjs [--cli <version>] [--remote <owner/repo[#ref]>] [--keep]
//
// Default (local): exports exactly the files git would publish (tracked + untracked, minus ignored), and runs the
// published CLI with CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR pointing at that export. This exercises the whole CLI pipeline
// except the GitHub download.
// --remote: runs the CLI against a GitHub template (needs it pushed and reachable), i.e. the exact user flow.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows resolves `npx`/`yarn` to `.cmd` shims, which `spawnSync` only finds through a shell.
const WINDOWS = process.platform === "win32";
const args = process.argv.slice(2);
const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const cliVersion = opt("--cli") ?? "latest";
const remote = opt("--remote");
const keep = args.includes("--keep");
const template = remote ?? "fmartns/scaffold-hbar-verifiable-settlement";

const work = mkdtempSync(path.join(os.tmpdir(), "verify-scaffold-"));
const project = "generated-app";
const dir = path.join(work, project);
const failures = [];
const step = title => console.log(`\n== ${title}`);
const run = (cmd, cmdArgs, options = {}) => {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", shell: WINDOWS, ...options });
  if (r.status !== 0) {
    console.error(`FAILED (${r.status}): ${cmd} ${cmdArgs.join(" ")}`);
    process.exit(1);
  }
};
const expect = (condition, message) => {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const env = { ...process.env };
if (!remote) {
  step("Export the files git would publish");
  const templateDir = path.join(work, "template");
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(f => f && existsSync(path.join(root, f)));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(templateDir, f)), { recursive: true });
    cpSync(path.join(root, f), path.join(templateDir, f));
  }
  console.log(`  ${files.length} files`);
  env.CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR = templateDir;
}

step(`Scaffold with create-scaffold-hbar@${cliVersion} (${remote ? "GitHub" : "local export"})`);
run(
  "npx",
  [
    "--yes",
    `create-scaffold-hbar@${cliVersion}`,
    project,
    "--template",
    template,
    "--frontend",
    "nextjs-app",
    "--solidity-framework",
    "none",
    "--package-manager",
    "yarn",
    "--network",
    "testnet",
    "--skip-hedera-skills",
    "--yes",
  ],
  { cwd: work, env },
);

step("Inspect the generated project");
const exists = p => existsSync(path.join(dir, p));
const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
for (const p of ["hardhat", "nextjs", "sdk"]) expect(exists(`packages/${p}/package.json`), `packages/${p} present`);
expect(!exists("packages/foundry"), "packages/foundry absent");
expect(exists("packages/hardhat/node_modules") && exists("packages/sdk/node_modules") && exists("packages/nextjs/node_modules"), "dependencies installed");
expect(exists(".yarn/releases") && exists("yarn.lock"), "pinned Yarn release and lockfile preserved");
expect(
  exists(".env.example") && exists(".gitignore") && exists("AGENTS.md") && exists("README.md"),
  "root metadata files preserved",
);
expect(!exists("template.json"), "template.json consumed and removed by the CLI (expected)");
expect(pkg.engines?.node === ">=20.19.0", `engines.node is ${pkg.engines?.node}`);
const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
expect(
  ["packages/hardhat", "packages/nextjs", "packages/sdk"].every(w => ws?.includes(w)),
  `workspaces: ${JSON.stringify(ws)}`,
);
for (const s of ["dev", "build", "lint", "check"]) expect(Boolean(pkg.scripts?.[s]), `root script "${s}"`);
expect(
  execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).trim().length > 0,
  "initial git commit created",
);

step("Run yarn setup without credentials: it must fail cleanly and never print secrets");
{
  const clean = { ...process.env };
  for (const name of [
    "HEDERA_NETWORK",
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_KEY",
    "HEDERA_MIRROR_NODE_URL",
  ])
    delete clean[name];
  const setup = spawnSync("yarn", ["setup"], { cwd: dir, env: clean, encoding: "utf8", shell: WINDOWS });
  expect(setup.status === 1, `yarn setup exits 1 without credentials (got ${setup.status})`);
  expect(/MISSING_ENV/.test(setup.stdout), "yarn setup names the missing variables");
}

step("Run the Hedera Harness validators (static invariants, secret scan, install, lint, types, tests, build)");
expect(exists(".harness/spec.yaml") && exists(".harness/validators/static.json"), "harness recipe copied");
run("yarn", ["harness:validate"], { cwd: dir });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log(`\nScaffold verified: ${dir}`);
if (!keep) rmSync(work, { recursive: true, force: true });
