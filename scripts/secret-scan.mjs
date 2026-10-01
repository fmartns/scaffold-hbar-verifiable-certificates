#!/usr/bin/env node
// Secret scan of the full git history (every ref, merge commits included) and of the working tree (tracked files plus
// untracked files that are not gitignored), with the rules in .gitleaks.toml. See docs/security.md (Secret scanning).
//
//   node scripts/secret-scan.mjs              history + working tree
//   node scripts/secret-scan.mjs --history    history only
//   node scripts/secret-scan.mjs --tree       working tree only
//   node scripts/secret-scan.mjs --self-test  proves the custom rules fire on keys generated at runtime
//
// Exit codes: 0 clean, 1 leaks found, 2 the scan could not run (gitleaks missing, shallow clone, gitleaks error).
// Findings are printed as rule, file, commit and line only: a matched value is never printed (gitleaks runs with
// --redact and the report's Match/Secret fields are never read here).
//
// Requires gitleaks >= 8.21 on PATH, or GITLEAKS_BIN pointing at it. CI must check out the full history
// (actions/checkout with fetch-depth: 0); a shallow clone is refused instead of reporting a partial scan as clean.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = path.join(root, ".gitleaks.toml");
const gitleaks = process.env.GITLEAKS_BIN || "gitleaks";
const args = new Set(process.argv.slice(2));
const known = new Set(["--history", "--tree", "--self-test"]);

class ScanError extends Error {}

function run(cmd, cmdArgs, options = {}) {
  return spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function git(...gitArgs) {
  const r = run("git", gitArgs);
  if (r.status !== 0) throw new ScanError(`git ${gitArgs[0]} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}

function requireGitleaks() {
  const r = run(gitleaks, ["version"]);
  if (r.error || r.status !== 0) {
    throw new ScanError(
      `gitleaks was not found (${gitleaks}). Install it (macOS: brew install gitleaks; other platforms: ` +
        "https://github.com/gitleaks/gitleaks/releases) or set GITLEAKS_BIN.",
    );
  }
  return r.stdout.trim();
}

/** Runs gitleaks and returns its findings, reduced to fields that never contain the secret. */
function gitleaksScan(gitleaksArgs, stripPrefix = "") {
  const reportDir = mkdtempSync(path.join(tmpdir(), "secret-scan-report-"));
  const report = path.join(reportDir, "report.json");
  try {
    const r = run(gitleaks, [
      ...gitleaksArgs,
      "--config",
      config,
      "--redact",
      "--no-banner",
      "--log-level",
      "error",
      "--report-format",
      "json",
      "--report-path",
      report,
      "--exit-code",
      "1",
    ]);
    if (r.error) throw new ScanError(`gitleaks could not start: ${r.error.message}`);
    let findings;
    try {
      findings = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      throw new ScanError(`gitleaks failed (exit ${r.status}): ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
    }
    if (!Array.isArray(findings)) throw new ScanError("gitleaks wrote an unexpected report.");
    return findings.map(f => ({
      rule: f.RuleID,
      file: stripPrefix && f.File.startsWith(stripPrefix) ? f.File.slice(stripPrefix.length) : f.File,
      line: f.StartLine,
      commit: f.Commit ? f.Commit.slice(0, 12) : null,
    }));
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function scanHistory() {
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    throw new ScanError(
      "This is a shallow clone, so the history scan would be partial. Fetch the full history " +
        "(git fetch --unshallow, or actions/checkout with fetch-depth: 0).",
    );
  }
  const commits = git("rev-list", "--all").split("\n").filter(Boolean).length;
  // -m also scans what merge commits introduce (conflict resolutions), which plain `git log -p` skips.
  const findings = gitleaksScan(["git", "--log-opts=--all -m", root]);
  return { label: `history (${commits} commits, all refs)`, findings };
}

function scanTree() {
  const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
  const stage = mkdtempSync(path.join(tmpdir(), "secret-scan-tree-"));
  try {
    let copied = 0;
    for (const file of new Set(files)) {
      const source = path.join(root, file);
      if (!existsSync(source) || !lstatSync(source).isFile()) continue; // deleted in the tree, symlink or submodule
      const target = path.join(stage, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied++;
    }
    const findings = gitleaksScan(["dir", stage], `${stage}${path.sep}`);
    return { label: `working tree (${copied} files, gitignored files excluded)`, findings };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Generates fake keys at runtime (never committed) and checks that each custom rule fires and allowlists hold. */
function selfTest() {
  const hex = () => randomBytes(32).toString("hex");
  const words = Array.from({ length: 12 }, (_, i) => ["alpha", "bravo", "delta", "gamma", "lunar", "tiger"][i % 6]);
  const samples = [
    ["hedera-ed25519-der-private-key", `HEDERA_OPERATOR_KEY=302e020100300506032b657004220420${hex()}`],
    ["hedera-ecdsa-der-private-key", `const k = "3030020100300706052b8104000a04220420${hex()}";`],
    ["hex-private-key-assignment", `DEPLOYER_PRIVATE_KEY=0x${hex()}`],
    ["mnemonic-assignment", `MNEMONIC="${words.join(" ")}"`],
  ];
  const ignored = [`  eventKey: "0x${hex()}",`, `  credentialId: "0x${hex()}",`, `    credentialHash: "0x${hex()}",`];
  const dir = mkdtempSync(path.join(tmpdir(), "secret-scan-selftest-"));
  try {
    samples.forEach(([, line], i) => writeFileSync(path.join(dir, `positive-${i}.txt`), `${line}\n`));
    writeFileSync(path.join(dir, "negative.ts"), `${ignored.join("\n")}\n`);
    const findings = gitleaksScan(["dir", dir], `${dir}${path.sep}`);
    const problems = [];
    samples.forEach(([rule], i) => {
      if (!findings.some(f => f.file === `positive-${i}.txt` && f.rule === rule)) problems.push(`${rule} did not fire`);
    });
    for (const f of findings.filter(f => f.file === "negative.ts")) {
      problems.push(`public identifier on line ${f.line} was flagged by ${f.rule}`);
    }
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  for (const a of args) if (!known.has(a)) throw new ScanError(`Unknown option ${a}. Use --history, --tree or --self-test.`);
  if (!existsSync(config)) throw new ScanError(".gitleaks.toml is missing at the repository root.");
  console.log(`Secret scan (gitleaks ${requireGitleaks()}, config .gitleaks.toml)`);

  if (args.has("--self-test")) {
    const problems = selfTest();
    for (const p of problems) console.error(`  FAIL  ${p}`);
    console.log(problems.length ? "Self-test failed." : "  ok    every custom rule fires; public identifiers are ignored");
    process.exit(problems.length ? 1 : 0);
  }

  const onlyHistory = args.has("--history") && !args.has("--tree");
  const onlyTree = args.has("--tree") && !args.has("--history");
  const results = [];
  if (!onlyTree) results.push(scanHistory());
  if (!onlyHistory) results.push(scanTree());

  let total = 0;
  for (const { label, findings } of results) {
    total += findings.length;
    console.log(`  ${findings.length ? "FAIL" : "ok  "}  ${label}: ${findings.length} finding(s)`);
    for (const f of findings) {
      console.log(`        ${f.rule}  ${f.file}:${f.line}${f.commit ? `  commit ${f.commit}` : ""}`);
    }
  }
  if (total > 0) {
    console.log(
      "\nPossible secrets found (values redacted). Rotate any real credential first, then remove it from history. " +
        "If a finding is a public value, add a narrow, documented allowlist entry to .gitleaks.toml.",
    );
  }
  process.exit(total > 0 ? 1 : 0);
} catch (e) {
  if (!(e instanceof ScanError)) throw e;
  console.error(`Secret scan could not run: ${e.message}`);
  process.exit(2);
}
