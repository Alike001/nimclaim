// Owner-operated encrypted backup for the isolated MAINNET claims database.
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { protectedLocalFile } from "./staging-admin.js";
import { mainnetConfig, mainnetIdentity } from "../server/postgres/mainnet.js";
import { createPool } from "../server/postgres/db.js";
import { encryptedDump } from "./postgres-backup.js";

async function main() {
  const [configPath, keyPath, archive] = process.argv.slice(2);
  if (!configPath || !keyPath || !archive)
    throw new Error(
      "Use mainnet:backup ADMIN_ENV_FILE 32_BYTE_KEY_FILE ENCRYPTED_ARCHIVE",
    );
  const env = parseEnv(protectedLocalFile(configPath));
  const { runtime } = mainnetConfig(env, true);
  const keyInfo = lstatSync(keyPath);
  if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0 || keyInfo.size !== 32)
    throw new Error("Backup key must be a protected 32-byte regular file");
  const key = readFileSync(keyPath);
  if (
    !/^pg_dump \(PostgreSQL\) 17\./.test(
      execFileSync("pg_dump", ["--version"], { encoding: "utf8" }).trim(),
    )
  )
    throw new Error("PostgreSQL 17 pg_dump is required");
  const pool = createPool(runtime);
  let counts = { campaigns: 0, invitations: 0, claims: 0, events: 0 };
  try {
    const version = Number(
      (await pool.query("SHOW server_version_num")).rows[0].server_version_num,
    );
    const settings = Object.fromEntries(
      (
        await pool.query("SELECT key,value FROM settings ORDER BY key")
      ).rows.map((row) => [row.key, row.value]),
    );
    if (
      Math.floor(version / 10000) !== 17 ||
      settings.network !== "mainnet" ||
      settings.deployment !== mainnetIdentity.deployment
    )
      throw new Error("Refusing a non-MAINNET database");
    const rows = (
      await pool.query(
        "SELECT (SELECT count(*) FROM campaigns) AS campaigns, (SELECT count(*) FROM invitations) AS invitations, (SELECT count(*) FROM claims) AS claims, (SELECT count(*) FROM events) AS events",
      )
    ).rows[0];
    counts = {
      campaigns: Number(rows.campaigns),
      invitations: Number(rows.invitations),
      claims: Number(rows.claims),
      events: Number(rows.events),
    };
  } finally {
    await pool.end();
  }
  const pgEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(pgEnv))
    if (
      name.startsWith("PG") ||
      [
        "DATABASE_URL",
        "DIRECT_DATABASE_URL",
        "RESTORE_DATABASE_URL",
        "PRODUCTION_DATABASE_HOST",
        "APP_ORIGIN",
      ].includes(name)
    )
      delete pgEnv[name];
  Object.assign(pgEnv, {
    PGHOST: runtime.host,
    PGPORT: "5432",
    PGUSER: runtime.user,
    PGPASSWORD: String(runtime.password),
    PGDATABASE: runtime.database,
    PGSSLMODE: "verify-full",
    // libpq does not use Node.js's TLS CA configuration. PostgreSQL 17
    // must be told to use the operating system's trusted CA roots.
    // This preserves hostname verification and does not weaken TLS.
    PGSSLROOTCERT: "system",
    PGCHANNELBINDING: "require",
  });
  try {
    await encryptedDump(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      pgEnv,
      key,
      archive,
    );
    console.log(
      `Encrypted MAINNET backup completed: ${counts.campaigns} campaigns, ${counts.invitations} invitations, ${counts.claims} claims and ${counts.events} history events.`,
    );
  } finally {
    key.fill(0);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077);
  main().catch(() => {
    console.error(
      "MAINNET backup refused or failed; check protected inputs, direct TLS target and PostgreSQL 17 pg_dump.",
    );
    process.exitCode = 1;
  });
}
