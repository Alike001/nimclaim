// Explicit local preparation only; never imported by HTTP startup.
import { parseEnv } from "node:util";
import { readFileSync } from "node:fs";
import { protectedLocalFile } from "./staging-admin.js";
import { mainnetConfig, mainnetIdentity } from "../server/postgres/mainnet.js";
import { createPool } from "../server/postgres/db.js";
import { migrate, bootstrap } from "../server/postgres/admin.js";
import { verifySchema } from "../server/postgres/schema.js";
import { verifyRuntimeRole } from "../server/postgres/permissions.js";

process.umask(0o077);
try {
  const [mode, configPath, credentialsPath, ...extra] = process.argv.slice(2);
  if (
    !["migrate", "bootstrap", "grants", "verify"].includes(mode) ||
    !configPath ||
    extra.length ||
    (mode === "bootstrap" ? !credentialsPath : credentialsPath)
  )
    throw new Error();
  // All settings come from the named protected file, never ambient connection secrets.
  const env = parseEnv(protectedLocalFile(configPath));
  const { runtime } = mainnetConfig(env, mode !== "verify");
  const pool = createPool(runtime);
  try {
    if (mode === "migrate") {
      const { server_version_num } = (
        await pool.query("SHOW server_version_num")
      ).rows[0];
      if (Math.floor(Number(server_version_num) / 10000) !== 17)
        throw new Error();
      await migrate(
        pool,
        mainnetIdentity.directory,
        mainnetIdentity.deployment,
      );
    }
    if (mode === "bootstrap") {
      await verifySchema(pool, false, mainnetIdentity);
      const credentials = JSON.parse(protectedLocalFile(credentialsPath!));
      await bootstrap(
        pool,
        credentials.PRODUCTION_ORGANISER_PASSWORD_HASH,
        mainnetIdentity,
      );
    }
    await verifySchema(pool, mode !== "migrate", mainnetIdentity);
    if (mode === "grants")
      await pool.query(
        readFileSync(
          new URL("./nimclaim-mainnet-grants.sql", import.meta.url),
          "utf8",
        ),
      );
    if (mode === "verify") await verifyRuntimeRole(pool, true);
  } finally {
    await pool.end();
  }
  console.log(`MAINNET ${mode} completed`);
} catch {
  console.error(
    "MAINNET administrative command refused; check protected files and separate database target",
  );
  process.exitCode = 1;
}
