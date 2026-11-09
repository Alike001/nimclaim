// Local explicit administrative entry point. No role creation or password output.
import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { neonConnection, createPool } from "../server/postgres/db.js";
import { migrate, bootstrap } from "../server/postgres/admin.js";
import { verifySchema } from "../server/postgres/schema.js";

export function protectedLocalFile(path: string) {
  if (
    !/^\.local\/[a-zA-Z0-9_./-]+$/.test(path) ||
    path.split("/").includes("..")
  )
    throw new Error("Ignored local file required");
  // Refuse symlinks anywhere along the path, including parent directories.
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++)
    if (lstatSync(parts.slice(0, i).join("/")).isSymbolicLink())
      throw new Error("Symlink refused");
  const st = lstatSync(path);
  if (!st.isFile() || (st.mode & 0o077) !== 0)
    throw new Error("Protected regular file required");
  execFileSync("git", ["check-ignore", "--quiet", path], { stdio: "pipe" });
  if (execFileSync("git", ["ls-files", "--", path]).length)
    throw new Error("Secret file is tracked");
  return readFileSync(path, "utf8");
}

export function adminConfig(env: NodeJS.ProcessEnv) {
  if (
    env.NETWORK !== "testnet" ||
    env.SPENDING_ENABLED !== "false" ||
    env.RPC_URL ||
    env.RPC_AUTHORIZATION ||
    env.SPENDING_NETWORK ||
    env.DATABASE_PATH ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new Error("Safe TESTNET administrative environment required");
  const config = neonConnection(env.DIRECT_DATABASE_URL, false);
  if (
    config.database !== "nimclaim" ||
    config.host !== "ep-royal-sunset-b9d4cl7u.c-7.eu-central-1.aws.neon.tech" ||
    config.user === "nimclaim_app"
  )
    throw new Error("Approved direct administrative target required");
  return config;
}

async function main() {
  process.umask(0o077);
  const [mode, envPath, credentialPath, ...extra] = process.argv.slice(2);
  if (
    !["migrate", "bootstrap"].includes(mode) ||
    !envPath ||
    extra.length ||
    (mode === "migrate" && credentialPath) ||
    (mode === "bootstrap" && !credentialPath)
  )
    throw new Error("Explicit command and file paths required");
  const env = parseEnv(protectedLocalFile(envPath));
  // Network/spending settings are public command settings; secret values come
  // exclusively from the protected file, never ambient DATABASE_URL variables.
  const config = adminConfig({
    ...process.env,
    DIRECT_DATABASE_URL: env.DIRECT_DATABASE_URL,
  });
  let hash: string | undefined;
  if (mode === "bootstrap") {
    const credentials = JSON.parse(protectedLocalFile(credentialPath!));
    hash = credentials.STAGING_ORGANISER_PASSWORD_HASH;
    if (!hash || !/^[a-f0-9]{64}:[a-f0-9]{128}$/.test(hash))
      throw new Error("Fresh staging hash required");
  }
  const pool = createPool(config);
  try {
    if (
      (await pool.query("SELECT current_database() AS name")).rows[0].name !==
      "nimclaim"
    )
      throw new Error("Wrong database");
    if (mode === "migrate") await migrate(pool);
    else {
      await verifySchema(pool, false);
      await bootstrap(pool, hash!);
    }
    await verifySchema(pool, mode === "bootstrap");
  } finally {
    await pool.end();
  }
  console.log(
    mode === "migrate"
      ? "Reviewed staging migrations verified; no organiser created"
      : "One-time staging organiser bootstrap completed",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch {
    console.error(
      "Staging administrative command refused; no credentials or driver details logged",
    );
    process.exitCode = 1;
  }
}
