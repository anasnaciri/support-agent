// OpenNext → Cloudflare Workers adapter config for the operator admin console.
// Like the dashboard, apps/admin is a pure api client (calls apps/api with the
// ADMIN_API_TOKEN) — the default Cloudflare config is enough. See DEPLOY.md
// "Admin console (Cloudflare Workers)".
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
