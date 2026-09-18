import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";
import path from "path";

// A single .env at the repository root feeds every workspace. Only NEXT_PUBLIC_* variables reach the browser.
loadEnvConfig(path.join(__dirname, "../.."));

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  devIndicators: false,
  // @sh/sdk is consumed as TypeScript source.
  transpilePackages: ["@sh/sdk"],
};

export default nextConfig;
