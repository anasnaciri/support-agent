// OpenNext → Cloudflare Workers adapter config for the merchant dashboard
// (Path B slice 9). The dashboard is a pure api client — no Postgres/Drizzle
// or pg-boss on the edge — so the default Cloudflare config is enough; all
// state lives behind apps/api. See DEPLOY.md "Dashboard (Cloudflare Workers)".
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
