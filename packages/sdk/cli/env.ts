/** Shared entry-point helpers of the SDK command-line tools. */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepositoryRoot } from "../certificates/config";

/** Loads the repository-root .env without overriding variables already set. Returns whether the file existed. */
export function loadRootEnv(): boolean {
  const file = path.join(findRepositoryRoot(), ".env");
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

/** True when the module at `moduleUrl` is the script Node was started with (not imported by a test). */
export const isEntryPoint = (moduleUrl: string): boolean =>
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
