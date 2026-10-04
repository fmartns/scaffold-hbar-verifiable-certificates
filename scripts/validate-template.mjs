#!/usr/bin/env node
// Validates template.json against the create-scaffold-hbar manifest contract, and the repository against template.json.
// Run it in CI on the template repository (`node scripts/validate-template.mjs`). A scaffolded project no longer contains
// template.json: the CLI consumes and deletes it.
//
// The checks below mirror `TemplateManifestSchema` of create-scaffold-hbar 0.4.1 (src/types.ts @ 5e05959, unchanged on
// main @ eae5701). The CLI does not export its schema, so this is a pinned reimplementation: the authoritative proof is
// running the real CLI (`node scripts/verify-scaffold.mjs`).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const errors = [];
const fail = message => errors.push(message);

const isObject = v => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = v => typeof v === "string" && v.length > 0;
const isNonEmptyArray = v => Array.isArray(v) && v.length > 0;

const FRONTENDS = ["nextjs-app", "none"];
const FRAMEWORKS = ["hardhat", "foundry", "none"];
const PACKAGE_MANAGERS = ["yarn", "npm", "none"];
const BLOCK_KEYS = ["capabilities", "defaults", "envVars", "outro"];
// Accepted by the CLI schema but never read by the CLI (verified in 0.4.0): keeping them would only mislead.
const INERT_BLOCK_KEYS = ["requirements", "instructions"];

function checkEnum(values, allowed, where) {
  if (!Array.isArray(values)) return fail(`${where} must be an array.`);
  for (const v of values) if (!allowed.includes(v)) fail(`${where} contains "${v}"; allowed: ${allowed.join(", ")}.`);
}

function checkOutro(outro) {
  if (!isObject(outro)) return fail("outro must be an object.");
  if (outro.sections === undefined && outro.steps === undefined && outro.installCommand === undefined) {
    fail("outro must define at least one of sections, steps or installCommand.");
  }
  if (outro.steps !== undefined) fail("outro.steps is deprecated; use outro.sections.");
  for (const [i, section] of (outro.sections ?? []).entries()) {
    if (section.title !== undefined && !isNonEmptyString(section.title))
      fail(`outro.sections[${i}].title must be a non-empty string.`);
    if (!isNonEmptyArray(section.steps)) fail(`outro.sections[${i}].steps must be a non-empty array.`);
    for (const [j, step] of (section.steps ?? []).entries()) {
      const fields = ["label", "command", "url", "text"];
      if (!fields.some(f => step[f] !== undefined))
        fail(`outro.sections[${i}].steps[${j}] needs one of label, command, url or text.`);
      for (const f of fields)
        if (step[f] !== undefined && !isNonEmptyString(step[f]))
          fail(`outro.sections[${i}].steps[${j}].${f} must be a non-empty string.`);
    }
  }
  if (outro.sections !== undefined && !isNonEmptyArray(outro.sections))
    fail("outro.sections must be a non-empty array.");
}

// 1. Manifest shape.
let manifest;
try {
  manifest = JSON.parse(read("template.json"));
} catch (e) {
  console.error(`template.json could not be read as JSON: ${e.message}`);
  process.exit(1);
}
if (!isObject(manifest)) {
  console.error("template.json must be a JSON object.");
  process.exit(1);
}
if (!isNonEmptyString(manifest.name))
  fail('"name" is required and must be a non-empty string (the CLI throws without it).');
for (const key of Object.keys(manifest)) {
  if (!["name", "description", "version", "create-scaffold-hbar"].includes(key))
    fail(`Unknown top-level key "${key}"; the CLI ignores it.`);
}
const block = manifest["create-scaffold-hbar"] ?? {};
if (!isObject(block)) fail('"create-scaffold-hbar" must be an object.');
const caps = isObject(block.capabilities) ? block.capabilities : {};
const defaults = isObject(block.defaults) ? block.defaults : {};

for (const key of Object.keys(isObject(block) ? block : {})) {
  if (INERT_BLOCK_KEYS.includes(key)) fail(`"${key}" is accepted by the schema but never used by the CLI; remove it.`);
  else if (!BLOCK_KEYS.includes(key)) fail(`Unknown key "create-scaffold-hbar.${key}"; the CLI ignores it.`);
}
if (caps.frontend !== undefined) checkEnum(caps.frontend, FRONTENDS, "capabilities.frontend");
if (caps.solidityFramework !== undefined)
  checkEnum(caps.solidityFramework, FRAMEWORKS, "capabilities.solidityFramework");
if (caps.packageManager !== undefined) checkEnum(caps.packageManager, PACKAGE_MANAGERS, "capabilities.packageManager");
for (const [key, allowed] of [
  ["frontend", FRONTENDS],
  ["solidityFramework", FRAMEWORKS],
  ["packageManager", PACKAGE_MANAGERS],
]) {
  if (defaults[key] === undefined) continue;
  if (!allowed.includes(defaults[key]))
    fail(`defaults.${key} "${defaults[key]}" is not one of: ${allowed.join(", ")}.`);
  else if (caps[key] && !caps[key].includes(defaults[key]))
    fail(`defaults.${key} "${defaults[key]}" is not in capabilities.${key}.`);
}
for (const [i, v] of (block.envVars ?? []).entries()) {
  if (!isNonEmptyString(v?.key)) fail(`envVars[${i}].key must be a non-empty string.`);
  if (typeof v?.description !== "string") fail(`envVars[${i}].description must be a string.`);
}
if (block.outro !== undefined) checkOutro(block.outro);

// 2. Manifest against the repository layout.
const pkgJson = JSON.parse(read("package.json"));
const workspaces = Array.isArray(pkgJson.workspaces) ? pkgJson.workspaces : (pkgJson.workspaces?.packages ?? []);
const packageDirs = existsSync(path.join(root, "packages")) ? readdirSync(path.join(root, "packages")) : [];

for (const fw of ["hardhat", "foundry"]) {
  const present = packageDirs.includes(fw);
  const declared = (caps.solidityFramework ?? []).includes(fw);
  if (present !== declared)
    fail(
      `packages/${fw} ${present ? "exists" : "is missing"} but capabilities.solidityFramework ${declared ? "lists" : "does not list"} "${fw}".`,
    );
}
if (packageDirs.includes("nextjs") !== (caps.frontend ?? []).includes("nextjs-app")) {
  fail('packages/nextjs and capabilities.frontend "nextjs-app" disagree.');
}
if (caps.packageManager && !caps.packageManager.every(pm => pm === "yarn")) {
  fail(
    'Only "yarn" is supported: the CLI rewrites npm scripts for the hardhat and nextjs packages only, not for other workspaces.',
  );
}

// 3. Workspaces, engines and Yarn.
for (const dir of packageDirs) {
  if (!workspaces.includes(`packages/${dir}`)) fail(`packages/${dir} is not listed in the root "workspaces".`);
  const name = JSON.parse(read(`packages/${dir}/package.json`)).name;
  if (!/^@sh\/\w+$/.test(name))
    fail(`packages/${dir} is named "${name}"; the CLI rewrites scripts only for "@sh/<name>" workspaces.`);
}
if (!pkgJson.engines?.node) fail('Root package.json has no "engines.node".');
if (!/^yarn@/.test(pkgJson.packageManager ?? "")) fail('Root "packageManager" must pin yarn.');
const yarnPath = /^yarnPath:\s*(\S+)/m.exec(read(".yarnrc.yml"))?.[1];
if (!yarnPath || !existsSync(path.join(root, yarnPath)))
  fail(".yarnrc.yml yarnPath is missing or points to a file that does not exist.");

// 4. Outro placeholders must resolve to real root scripts ({run:framework:x} resolves to the selected framework).
const framework = (caps.solidityFramework ?? [])[0];
const texts = (block.outro?.sections ?? [])
  .flatMap(s => s.steps ?? [])
  .flatMap(s => [s.command, s.text].filter(Boolean));
for (const text of texts) {
  for (const [, script] of text.matchAll(/\{run:([a-zA-Z0-9:_-]+)\}/g)) {
    const resolved = script.startsWith("framework:") ? `${framework}:${script.slice("framework:".length)}` : script;
    if (!pkgJson.scripts?.[resolved])
      fail(`Outro references {run:${script}} but the root script "${resolved}" does not exist.`);
  }
}

// 5. .env.example must equal what the CLI generates from envVars (the CLI overwrites the file).
if (block.envVars?.length) {
  const generated =
    block.envVars
      .flatMap(({ key, description }) => [`# ${description}`, `${key}=`, ""])
      .join("\n")
      .trimEnd() + "\n";
  // Compare with LF endings: a Windows checkout with core.autocrlf=true has CRLF in the working tree, while the
  // repository (and so the downloaded template) stores LF.
  if (!existsSync(path.join(root, ".env.example")) || read(".env.example").replace(/\r\n/g, "\n") !== generated) {
    fail(".env.example differs from the file the CLI generates from envVars; regenerate it from template.json.");
  }
}

if (errors.length > 0) {
  console.error("Template validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("template.json and the repository layout satisfy the create-scaffold-hbar contract.");
