#!/usr/bin/env node
// Enforces a coverage target on an Istanbul `coverage-summary.json` (used for the contracts: solidity-coverage has no
// thresholds of its own; Vitest enforces the SDK and frontend targets itself). Targets are documented in docs/testing.md.
//
//   node scripts/check-coverage.mjs <coverage-summary.json> lines=100 statements=100 functions=100 branches=95
import { existsSync, readFileSync } from "node:fs";

const [file, ...targets] = process.argv.slice(2);
if (!file || targets.length === 0) {
  console.error("usage: check-coverage.mjs <coverage-summary.json> <metric>=<percent>...");
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`${file} not found: run the coverage first.`);
  process.exit(2);
}

const total = JSON.parse(readFileSync(file, "utf8")).total;
const failures = [];
for (const target of targets) {
  const [metric, value] = target.split("=");
  const minimum = Number(value);
  const actual = total?.[metric]?.pct;
  if (typeof actual !== "number" || Number.isNaN(minimum)) {
    console.error(`unknown metric or target: ${target}`);
    process.exit(2);
  }
  const line = `${metric.padEnd(10)} ${actual.toFixed(2).padStart(6)}% (target ${minimum}%)`;
  if (actual < minimum) failures.push(line);
  console.log(`${actual < minimum ? "FAIL" : "ok  "} ${line}`);
}
if (failures.length > 0) {
  console.error(`Coverage below target in ${file}.`);
  process.exit(1);
}
