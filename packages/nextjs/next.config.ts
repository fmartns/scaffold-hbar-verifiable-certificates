import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import path from "path";

// A single .env at the repository root feeds every workspace. Only NEXT_PUBLIC_* variables reach the browser.
// `forceReload`: Next.js has already loaded (and cached) this app's own directory by the time the config runs.
loadEnvConfig(path.join(__dirname, "../.."), process.env.NODE_ENV !== "production", undefined, true);

/**
 * The certificate agents run only in route handlers (Node.js runtime). Their native libraries (Askar, AnonCreds,
 * zstd) and the ESM-only Credo packages are loaded by Node at run time, never bundled.
 */
const SERVER_EXTERNALS = [
  "@credo-ts/core",
  "@credo-ts/node",
  "@credo-ts/askar",
  "@credo-ts/anoncreds",
  "@credo-ts/hedera",
  "@openwallet-foundation/askar-nodejs",
  "@hyperledger/anoncreds-nodejs",
  "@hashgraph/sdk",
  "zstd-napi",
  "pdf-lib",
];

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  devIndicators: false,
  // @sh/sdk is consumed as TypeScript source.
  transpilePackages: ["@sh/sdk"],
  serverExternalPackages: SERVER_EXTERNALS,
  webpack(config, { isServer }) {
    // `serverExternalPackages` does not apply to imports made from a transpiled workspace (@sh/sdk), so the same
    // packages are declared external explicitly. Node resolves them from this app's node_modules at run time.
    if (isServer) {
      config.externals = [
        ...[config.externals ?? []].flat(),
        ({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) =>
          request && SERVER_EXTERNALS.some(name => request === name || request.startsWith(`${name}/`))
            ? callback(null, `commonjs ${request}`)
            : callback(),
      ];
    }
    return config;
  },
};

export default nextConfig;
