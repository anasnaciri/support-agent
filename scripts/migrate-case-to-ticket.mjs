#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const dryRun = process.argv.includes("--dry-run");

const trackedFiles = execFileSync("rg", ["--files", "-0"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const skipContent = (path) =>
  path.startsWith("packages/db/migrations/") ||
  path.includes("/dist/") ||
  path.includes("/.next/") ||
  path.includes("/.open-next/") ||
  path === "scripts/migrate-case-to-ticket.mjs";

const skipRename = (path) =>
  path.startsWith("packages/db/migrations/") ||
  path.includes("/dist/") ||
  path.includes("/.next/") ||
  path.includes("/.open-next/") ||
  path === "scripts/migrate-case-to-ticket.mjs";

const isText = (path) => {
  if (!existsSync(path)) return false;
  const buf = readFileSync(path);
  return !buf.includes(0);
};

const protectPatterns = [
  /\btoLowerCase\b/gu,
  /\btoUpperCase\b/gu,
  /\btoLocaleLowerCase\b/gu,
  /\btoLocaleUpperCase\b/gu,
  /\b[Nn]oFallthroughCasesInSwitch\b/gu,
  /\blowercase\b/giu,
  /\buppercase\b/giu,
  /\bcamelCase\b/gu,
  /\bcamelcase\b/giu,
  /\bPascalCase\b/gu,
  /\bsnake_case\b/gu,
  /\bkebab-case\b/gu,
  /\btitleCase\b/gu,
  /\bcase-insensitive(?:ly)?\b/giu,
  /\bcase-sensitive(?:ly)?\b/giu,
  /\bcase\/space-insensitive\b/giu,
  /\bCASE(?=\s+WHEN\b)/gu,
  /\bcase(?=\s+when\b)/gu,
  /\bcase(?=\s+["'`])/giu,
  /\bcase-by-case\b/giu,
  /\bnormal-case\b/giu,
  /\buse cases?\b/giu,
  /\buse-cases?\b/giu,
  /\bedge cases?\b/giu,
  /\bedge-cases?\b/giu,
  /\btest cases?\b/giu,
  /\btest-cases?\b/giu,
  /\bspecial cases?\b/giu,
  /\bspecial-cases?\b/giu,
  /\bspecial-casing\b/giu,
  /\bworst cases?\b/giu,
  /\bworst-cases?\b/giu,
  /\bbest cases?\b/giu,
  /\bbest-cases?\b/giu,
  /\bin case\b/giu,
  /\bin that case\b/giu,
  /\bin this case\b/giu,
  /\bcase 3\b/giu,
  /\blower case\b/giu,
  /\blower-cases?\b/giu,
  /\bupper case\b/giu,
  /\bupper-cases?\b/giu,
  /\bletter case\b/giu,
  /\bletter-cases?\b/giu,
  /\btitle case\b/giu,
  /\btitle-cases?\b/giu,
  /\bproper case\b/giu,
  /\bproper-cases?\b/giu,
];

const protectGenericCaseTerms = (input, replaceCaseTerms) => {
  const protectedValues = [];
  let text = input.replace(/^(\s*)case(?=\s+(?:(?:"|'|`)|[A-Za-z_$][\w$]*:))/gmu, (_m, indent) => {
    const key = `__CASE_PROTECT_${protectedValues.length}__`;
    protectedValues.push("case");
    return `${indent}${key}`;
  });

  for (const pattern of protectPatterns) {
    text = text.replace(pattern, (match) => {
      const key = `__CASE_PROTECT_${protectedValues.length}__`;
      protectedValues.push(match);
      return key;
    });
  }

  text = replaceCaseTerms(text);

  return text.replace(/__CASE_PROTECT_(\d+)__/gu, (_m, index) => {
    const value = protectedValues[Number(index)];
    if (value === undefined) {
      throw new Error(`Missing protected token ${index}`);
    }
    return value;
  });
};

const renameText = (input) =>
  protectGenericCaseTerms(input, (text) =>
    text
      .replace(/\bCASES(?=[^a-z]|$)/gu, "TICKETS")
      .replace(/\bCases(?=[^a-z]|$)/gu, "Tickets")
      .replace(/\bcases(?=[^a-z]|$)/gu, "tickets")
      .replace(/\bCASE(?=[^a-z]|$)/gu, "TICKET")
      .replace(/\bCase(?=[^a-z]|$)/gu, "Ticket")
      .replace(/\bcase(?=[^a-z]|$)/gu, "ticket")
      .replace(/(?<=[A-Za-z0-9_])Cases(?=[A-Z0-9_]|\b)/gu, "Tickets")
      .replace(/(?<=[A-Za-z0-9_])Case(?=[A-Z0-9_]|\b)/gu, "Ticket")
      .replace(/(?<=[A-Za-z0-9_])cases(?=[A-Z0-9_]|\b)/gu, "tickets")
      .replace(/(?<=[A-Za-z0-9_])case(?=[A-Z0-9_]|\b)/gu, "ticket"),
  );

const renamePath = (path) =>
  protectGenericCaseTerms(path, (text) =>
    text
      .replace(/\bCases(?=[^a-z]|$)/gu, "Tickets")
      .replace(/\bcases(?=[^a-z]|$)/gu, "tickets")
      .replace(/\bCase(?=[^a-z]|$)/gu, "Ticket")
      .replace(/\bcase(?=[^a-z]|$)/gu, "ticket")
      .replace(/(?<=[A-Za-z0-9_])Cases(?=[A-Z0-9_]|\b)/gu, "Tickets")
      .replace(/(?<=[A-Za-z0-9_])Case(?=[A-Z0-9_]|\b)/gu, "Ticket")
      .replace(/(?<=[A-Za-z0-9_])cases(?=[A-Z0-9_]|\b)/gu, "tickets")
      .replace(/(?<=[A-Za-z0-9_])case(?=[A-Z0-9_]|\b)/gu, "ticket"),
  );

const contentChanges = [];
for (const path of trackedFiles) {
  if (skipContent(path) || !isText(path)) continue;
  const before = readFileSync(path, "utf8");
  const after = renameText(before);
  if (after !== before) {
    contentChanges.push(path);
    if (!dryRun) writeFileSync(path, after);
  }
}

const pathChanges = trackedFiles
  .filter((path) => !skipRename(path))
  .map((from) => [from, renamePath(from)])
  .filter(([from, to]) => from !== to)
  .sort((a, b) => b[0].length - a[0].length);

for (const [from, to] of pathChanges) {
  if (dryRun) continue;
  if (!existsSync(from)) continue;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

if (!dryRun) {
  const dirs = [...new Set(pathChanges.map(([from]) => dirname(from)))]
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    if (dir === "." || !existsSync(dir)) continue;
    try {
      if (statSync(dir).isDirectory()) rmdirSync(dir);
    } catch {
      // Directory is not empty, which is fine.
    }
  }
}

console.log(
  JSON.stringify(
    {
      dryRun,
      contentChanges: contentChanges.length,
      pathChanges: pathChanges.length,
      sampleContentChanges: contentChanges.slice(0, 20),
      samplePathChanges: pathChanges.slice(0, 20),
    },
    null,
    2,
  ),
);
