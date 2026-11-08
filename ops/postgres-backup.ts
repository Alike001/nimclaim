import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createWriteStream,
  readFileSync,
  statSync,
  unlinkSync,
  lstatSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { neonConnection, createPool } from "../server/postgres/db.js";

const magic = Buffer.from("NIMCLAIM-PGDUMP-V1\n");
export async function encryptedDump(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  key: Buffer,
  out: string,
) {
  if (key.length !== 32) throw new Error("Backup key must be 32 random bytes");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const file = createWriteStream(out, { flags: "wx", mode: 0o600 });
  // Wait for exclusive creation before starting pg_dump; never remove an existing backup.
  await once(file, "open");
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ended = new Promise<number | null>((ok) => {
    child.once("error", () => ok(-1));
    child.once("close", ok);
  });
  try {
    file.write(Buffer.concat([magic, iv]));
    await pipeline(child.stdout!, cipher, file, { end: false });
    if ((await ended) !== 0) throw new Error("Dump failed");
    file.end(cipher.getAuthTag());
    await once(file, "close");
  } catch {
    child.kill();
    file.destroy();
    try {
      unlinkSync(out);
    } catch {}
    throw new Error("Encrypted backup failed");
  }
}
export function decryptDump(path: string, key: Buffer) {
  // Authenticate the complete archive BEFORE starting pg_restore. No unauthenticated SQL reaches Postgres.
  // Operator-side limit keeps memory bounded; no plaintext archive is ever written to disk.
  if (key.length !== 32 || statSync(path).size > 128 * 1024 * 1024)
    throw new Error("Invalid key or archive exceeds 128 MiB restore limit");
  const data = readFileSync(path);
  if (
    !data.subarray(0, magic.length).equals(magic) ||
    data.length < magic.length + 28
  )
    throw new Error("Invalid encrypted archive");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    data.subarray(magic.length, magic.length + 12),
  );
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    decipher.update(data.subarray(magic.length + 12, -16)),
    decipher.final(),
  ]);
}
export async function restoreDump(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  key: Buffer,
  path: string,
) {
  const plain = decryptDump(path, key);
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const ended = new Promise<number | null>((ok) => {
    child.once("error", () => ok(-1));
    child.once("close", ok);
  });
  try {
    await pipeline(Readable.from([plain]), child.stdin!);
    if ((await ended) !== 0) throw new Error("Restore failed");
  } catch {
    child.kill();
    throw new Error("Restore failed; transaction rolled back");
  } finally {
    plain.fill(0);
  }
}
async function main() {
  const [mode, keyPath, archive] = process.argv.slice(2);
  if (!["backup", "restore"].includes(mode) || !keyPath || !archive)
    throw new Error("Use backup|restore KEY_FILE ENCRYPTED_ARCHIVE");
  const info = lstatSync(keyPath);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Key must be a protected regular file (0600)");
  const key = readFileSync(keyPath);
  const config = neonConnection(
    mode === "backup"
      ? process.env.DIRECT_DATABASE_URL
      : process.env.RESTORE_DATABASE_URL,
    false,
  );
  const pool = createPool(config);
  try {
    if (mode === "backup") {
      const marker = (
        await pool.query("SELECT value FROM settings WHERE key='deployment'")
      ).rows[0]?.value;
      if (marker !== "isolated-neon-testnet-staging-v1")
        throw new Error("Wrong database");
    } else {
      const tables = await pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      );
      if (tables.rowCount)
        throw new Error("Restore requires a separate empty database");
    }
  } finally {
    await pool.end();
  }
  // Ignore ambient libpq routing/options from other projects. Only this approved
  // direct target and verified TLS settings may reach the backup tools.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env))
    if (
      name.startsWith("PG") ||
      [
        "DATABASE_URL",
        "DIRECT_DATABASE_URL",
        "RESTORE_DATABASE_URL",
        "STAGING_ORGANISER_PASSWORD_HASH",
      ].includes(name)
    )
      delete env[name];
  Object.assign(env, {
    PGHOST: config.host,
    PGPORT: "5432",
    PGUSER: config.user,
    PGPASSWORD: String(config.password),
    PGDATABASE: String(config.database),
    PGSSLMODE: "verify-full",
    PGCHANNELBINDING: "require",
  });
  if (mode === "backup")
    await encryptedDump(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl"],
      env,
      key,
      archive,
    );
  else
    await restoreDump(
      "pg_restore",
      [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--dbname",
        String(config.database),
      ],
      env,
      key,
      archive,
    );
  key.fill(0);
  console.log(
    mode === "backup"
      ? "Encrypted staging backup completed"
      : "Restore committed; run integrity and application acceptance checks before use",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077);
  main().catch(() => {
    console.error(
      "Backup/restore refused or failed; check protected inputs, direct TLS connection and tool versions",
    );
    process.exitCode = 1;
  });
}
