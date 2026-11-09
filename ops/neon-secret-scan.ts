// Read private values only to detect accidental publication. Print counts only.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { approvedConnections } from "./neon-target.js";
import { protectedLocalFile } from "./staging-admin.js";

try {
  const { direct, runtime } = approvedConnections();
  const env = parseEnv(readFileSync(".local/neon-staging.env", "utf8"));
  const secrets = [
    env.DATABASE_URL,
    env.DIRECT_DATABASE_URL,
    direct.password,
    runtime.password,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 7,
  );
  if (existsSync(".local/neon-runtime.env")) {
    const runtimeEnv = parseEnv(protectedLocalFile(".local/neon-runtime.env"));
    if (!runtimeEnv.DATABASE_URL) throw new Error();
    secrets.push(
      runtimeEnv.DATABASE_URL,
      decodeURIComponent(new URL(runtimeEnv.DATABASE_URL).password),
    );
  }
  if (existsSync(".local/staging/credentials.json")) {
    const credentials = JSON.parse(
      protectedLocalFile(".local/staging/credentials.json"),
    );
    for (const key of ["password", "STAGING_ORGANISER_PASSWORD_HASH"]) {
      if (typeof credentials[key] !== "string" || credentials[key].length < 8)
        throw new Error();
      secrets.push(credentials[key]);
    }
  }
  secrets.push(...secrets.map(encodeURIComponent));
  let checked = 0;
  function scan(bytes: Buffer) {
    checked++;
    const text = bytes.toString("utf8");
    if (secrets.some((secret) => text.includes(secret))) throw new Error();
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]/.test(text))
      throw new Error();
    if (/\b(?:ghp_|github_pat_|AKIA)[A-Za-z0-9_]{20,}/.test(text))
      throw new Error();
    // Existing reviewed parser fixtures are deliberately invalid synthetic URLs.
    const fixturesRemoved = text
      .replace(
        /postgres(?:ql)?:\/\/synthetic:example-only@ep-synthetic(?:-pooler)?\.eu-central-1\.aws\.neon\.tech\/nimclaim[^\s"']*/g,
        "",
      )
      .replace(/postgres:\/\/secret:password@localhost\/db/g, "");
    if (/postgres(?:ql)?:\/\/[^\s"'/:]+:[^\s"'@]+@/.test(fixturesRemoved))
      throw new Error();
  }
  const tracked = execFileSync("git", ["ls-files", "-z"])
    .toString()
    .split("\0")
    .filter((path) => !!path && existsSync(path));
  for (const path of tracked) scan(readFileSync(path));
  // Include untracked source additions that are about to be committed.
  const additions = execFileSync("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const path of additions) scan(readFileSync(path));
  const objects = execFileSync("git", ["rev-list", "--objects", "--all"], {
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .trim()
    .split("\n")
    .map((line) => line.split(" ")[0]);
  const metadata = execFileSync(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    { input: objects.join("\n") + "\n", maxBuffer: 16 * 1024 * 1024 },
  )
    .toString()
    .trim()
    .split("\n");
  let blobs = 0;
  for (const line of metadata) {
    const [id, type] = line.split(" ");
    if (type === "blob") {
      scan(
        execFileSync("git", ["cat-file", "blob", id], {
          maxBuffer: 32 * 1024 * 1024,
        }),
      );
      blobs++;
    }
  }
  let bundleFiles = 0;
  function bundle(path: string) {
    for (const entry of readdirSync(path)) {
      const file = join(path, entry);
      if (statSync(file).isDirectory()) bundle(file);
      else {
        const bytes = readFileSync(file);
        scan(bytes);
        bundleFiles++;
        if (
          /DIRECT_DATABASE_URL|STAGING_ORGANISER_PASSWORD_HASH|DATABASE_URL/.test(
            bytes.toString("utf8"),
          )
        )
          throw new Error();
      }
    }
  }
  bundle("dist");
  console.log(
    `PASS secret scan: ${tracked.length} tracked files, ${additions.length} additions, ${blobs} history blobs, ${bundleFiles} bundle files (${checked} checks); private values and high-confidence patterns absent`,
  );
} catch {
  console.error("FAIL secret scan; values and matching content suppressed");
  process.exitCode = 1;
}
