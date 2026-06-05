import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared HTTP contracts ship as TypeScript source; let Next compile
  // them alongside the admin app (same approach as apps/dashboard).
  transpilePackages: ["@support-agent/dashboard-contracts"],
};

export default config;
