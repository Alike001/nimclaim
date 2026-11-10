import test from "node:test";
import assert from "node:assert/strict";
import { mainnetConfig, mainnetRoute } from "../server/postgres/mainnet.js";
import { migrationPlan } from "../server/postgres/schema.js";
import { mainnetIdentity } from "../server/postgres/mainnet.js";
import { readFileSync } from "node:fs";
const databaseUrl = new URL(
  "postgresql://ep-production-pooler.eu-central-1.aws.neon.tech/nimclaim_mainnet?sslmode=verify-full",
);
databaseUrl.username = "nimclaim_app";
databaseUrl.password = "test-only";

const env = {
  NODE_ENV: "production",
  NIMCLAIM_PRODUCTION: "1",
  NETWORK: "mainnet",
  SPENDING_ENABLED: "false",
  MAX_PAYMENT_LUNA: "0",
  PAYMENT_FEE_LUNA: "0",
  APP_ORIGIN: "https://nimclaim-mainnet.onrender.com",
  PRODUCTION_DATABASE_HOST: "ep-production.eu-central-1.aws.neon.tech",
  DATABASE_URL: databaseUrl.toString(),
};
test("MAINNET configuration pins independent TLS database, role, origin and spending block", () => {
  assert.equal(mainnetConfig(env).runtime.database, "nimclaim_mainnet");
  assert.deepEqual(mainnetConfig(env).runtime.ssl, {
    rejectUnauthorized: true,
    servername: "ep-production-pooler.eu-central-1.aws.neon.tech",
  });
  for (const patch of [
    { NETWORK: "testnet" },
    { SPENDING_ENABLED: "true" },
    { MAX_PAYMENT_LUNA: "1" },
    { PAYMENT_FEE_LUNA: "1" },
    { NIMCLAIM_STAGING: "1" },
    { DATABASE_PATH: "local.sqlite" },
    { MOBILE_TEST: "1" },
    { NIMCLAIM_MOBILE_TEST: "1" },
    { RPC_URL: "https://rpc.invalid" },
    { SPENDING_NETWORK: "mainnet" },
    { DIRECT_DATABASE_URL: env.DATABASE_URL },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { STAGING_ORGANISER_PASSWORD_HASH: "synthetic" },
    { APP_ORIGIN: "http://example.com" },
    { APP_ORIGIN: "https://example.com/" },
    { APP_ORIGIN: "https://nimclaim-testnet-staging.onrender.com" },
    {
      DATABASE_URL: env.DATABASE_URL.replace("/nimclaim_mainnet", "/nimclaim"),
    },
    { DATABASE_URL: env.DATABASE_URL.replace("nimclaim_app:", "owner:") },
    {
      PRODUCTION_DATABASE_HOST:
        "ep-royal-sunset-b9d4cl7u.c-7.eu-central-1.aws.neon.tech",
    },
    { PRODUCTION_DATABASE_HOST: "ep-other.eu-central-1.aws.neon.tech" },
    { DATABASE_URL: env.DATABASE_URL + "&sslmode=disable" },
  ])
    assert.throws(
      () => mainnetConfig({ ...env, ...patch }),
      JSON.stringify(Object.keys(patch)),
    );
});
test("MAINNET gateway allows signing only, never dispatch or hash-based settlement", () => {
  const id = "12345678-1234-1234-1234-123456789012";
  assert.equal(
    mainnetRoute("POST", `/api/campaigns/${id}/wallet/challenge`),
    true,
  );
  assert.equal(mainnetRoute("POST", `/api/campaigns/${id}/wallet`), true);
  for (const route of [
    `/api/claims/${id}/payment/review`,
    `/api/payments/${id}/dispatch`,
    `/api/payments/${id}/reconcile`,
    "/api/debug",
    "/api/campaigns?debug=1",
  ])
    assert.equal(mainnetRoute("POST", route), false);
});
test("MAINNET migrations have an independent ledger and seed only deployment identity", () => {
  assert.notEqual(
    migrationPlan()[0].checksum,
    migrationPlan(mainnetIdentity.directory)[0].checksum,
  );
  const sql = readFileSync(
    `${mainnetIdentity.directory}/001_claims.sql`,
    "utf8",
  );
  assert.match(sql, /isolated-mainnet-claims-v1/);
  assert.doesNotMatch(
    sql,
    /INSERT INTO (campaigns|claims|organiser|sessions)/i,
  );
});
