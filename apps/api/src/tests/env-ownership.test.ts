import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

const readRepoFile = (path: string) =>
  readFileSync(`${repoRoot}/${path}`, "utf8");

const envKeys = (path: string) =>
  readRepoFile(path)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });

describe("environment file ownership", () => {
  it("keeps env templates out of the repository root", () => {
    expect(existsSync(`${repoRoot}/.env.example`)).toBe(false);
    expect(existsSync(`${repoRoot}/.env.prod.example`)).toBe(false);
    expect(existsSync(`${repoRoot}/deploy/compose/.env.example`)).toBe(true);
  });

  it.each([
    "apps/admin/.env.example",
    "apps/api/.env.example",
    "apps/dashboard/.env.example",
    "apps/worker/.env.example",
    "packages/db/.env.example",
    "packages/providers/.env.example",
    "deploy/compose/.env.example",
    "deploy/railway/railway.env.example",
  ])("%s does not declare the same variable twice", (path) => {
    const keys = envKeys(path);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses owning app and package commands without a root API wrapper", () => {
    expect(existsSync(`${repoRoot}/scripts/restart-api.sh`)).toBe(false);

    const rootPackage = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts["api:restart"]).toBeUndefined();

    const apiPackage = JSON.parse(readRepoFile("apps/api/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(apiPackage.scripts["start:dev"]).toContain(
      "--env-file=.env.local",
    );

    const dbPackage = JSON.parse(readRepoFile("packages/db/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(dbPackage.scripts["db:migrate"]).toContain(
      "--env-file-if-exists=.env.local",
    );

    const providersPackage = JSON.parse(
      readRepoFile("packages/providers/package.json"),
    ) as { scripts: Record<string, string> };
    expect(providersPackage.scripts["llm:smoke"]).toContain(
      "--env-file-if-exists=.env.local",
    );
  });

  it("keeps compose configuration under deploy/compose", () => {
    const compose = readRepoFile("docker-compose.prod.yml");
    expect(compose).not.toContain(".env.prod");
    expect(compose).toContain("deploy/compose/.env");
  });

  it("avoids unsupported cache mounts in the Railway Dockerfile", () => {
    const dockerfile = readRepoFile("deploy/railway/Dockerfile");
    expect(dockerfile).not.toContain("--mount=type=cache");
  });

  it("starts Railway services by role and migrates before the api", () => {
    const dockerfile = readRepoFile("deploy/railway/Dockerfile");
    const startScript = readRepoFile("deploy/railway/start.sh");

    expect(dockerfile).toContain('CMD ["sh", "deploy/railway/start.sh"]');
    expect(startScript).toContain('case "${DEPLOY_ROLE:-api}"');
    expect(startScript.indexOf("pnpm db:migrate")).toBeLessThan(
      startScript.indexOf("exec node apps/api/dist/server.js"),
    );
    expect(startScript).toContain("exec node apps/worker/dist/index.js");
  });
});
