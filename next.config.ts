import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

initOpenNextCloudflareForDev({ configPath: "./wrangler.next-dev.jsonc" });

const nextConfig: NextConfig = {
  // The Argon2id package ships WebAssembly that expects its imports supplied at
  // instantiation. A bundler that tries to compile it looks for a module called
  // "env" and fails; leaving the package external hands it to the runtime,
  // which is what actually knows how to instantiate it.
  serverExternalPackages: ["argon2id"],
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
