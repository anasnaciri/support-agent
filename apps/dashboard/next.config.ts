import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace deps ship as TypeScript-source; let Next.js compile them
  // alongside the dashboard. The alternative (per-package `dist/` builds
  // via `tsc -b`) is what the rest of the monorepo uses, but for the
  // dashboard the dev loop is faster when Next.js owns compilation.
  transpilePackages: [
    "@support-agent/agent-core",
    "@support-agent/dashboard-contracts",
  ],
};

export default config;
