import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared HTTP contracts ship as TypeScript source; let Next compile
  // them alongside the admin app (same approach as apps/dashboard).
  transpilePackages: ["@support-agent/dashboard-contracts"],
};

export default config;

// OpenNext → Cloudflare Workers: makes Cloudflare bindings available during
// `next dev` (no-op for `next build` / production).
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
void initOpenNextCloudflareForDev();
