import { test } from "node:test";
import assert from "node:assert/strict";
import { stagingOrigin } from "../server/postgres/staging.js";

const origin = "https://nimclaim-testnet-staging-64nl.onrender.com";
const render = { RENDER: "true", RENDER_EXTERNAL_URL: origin };

test("Render origin accepts exact service hostnames including generated suffixes", () => {
  for (const label of [
    "nimclaim-testnet-staging",
    "nimclaim-testnet-staging-64nl",
    "a",
    "a".repeat(63),
  ]) {
    const url = `https://${label}.onrender.com`;
    assert.equal(
      stagingOrigin({ RENDER: "true", RENDER_EXTERNAL_URL: url }),
      url,
    );
  }
});

test("Render origin permits only exactly matching optional origin and hostname settings", () => {
  assert.equal(stagingOrigin({ ...render, APP_ORIGIN: origin }), origin);
  assert.equal(
    stagingOrigin({
      ...render,
      APP_ORIGIN: origin,
      RENDER_EXTERNAL_HOSTNAME: new URL(origin).hostname,
    }),
    origin,
  );
});

test("partial, conflicting or inconsistent Render settings never fall back to APP_ORIGIN", () => {
  for (const env of [
    { RENDER: "true" },
    { RENDER: "true", APP_ORIGIN: origin },
    { ...render, RENDER_EXTERNAL_URL: "", APP_ORIGIN: origin },
    { RENDER_EXTERNAL_URL: origin, APP_ORIGIN: origin },
    { RENDER_EXTERNAL_HOSTNAME: new URL(origin).hostname, APP_ORIGIN: origin },
    ...["false", "TRUE", "1", ""].map((RENDER) => ({ ...render, RENDER })),
    ...["", "https://other.onrender.com", `${origin}/`, `${origin}:443`].map(
      (APP_ORIGIN) => ({ ...render, APP_ORIGIN }),
    ),
    ...[
      "",
      "other.onrender.com",
      `${new URL(origin).hostname}.evil.example`,
    ].map((RENDER_EXTERNAL_HOSTNAME) => ({
      ...render,
      RENDER_EXTERNAL_HOSTNAME,
    })),
  ])
    assert.throws(() => stagingOrigin(env), /consistent origin settings/);
});

test("Render origin rejects noncanonical URLs and deceptive service hostnames without echoing input", () => {
  for (const url of [
    "not a URL",
    origin.replace("https:", "http:"),
    origin.replace("https:", "HTTPS:"),
    origin.replace("nimclaim", "NIMCLAIM"),
    `${origin}/`,
    `${origin}/path`,
    `${origin}/..`,
    `${origin}?`,
    `${origin}?a=1`,
    `${origin}#`,
    `${origin}#fragment`,
    `${origin}:443`,
    `${origin}:8443`,
    ` ${origin}`,
    `${origin}\n`,
    origin.replace("https://", "https://user:example-only@"),
    origin.replace("https://", "https://@"),
    "https://onrender.com",
    "https://evil-onrender.com",
    "https://service.onrender.com.evil.example",
    "https://service.onrender.com@evil.example",
    "https://service.onrender.com.",
    "https://nested.service.onrender.com",
    "https://-service.onrender.com",
    "https://service-.onrender.com",
    "https://service_name.onrender.com",
    `https://${"a".repeat(64)}.onrender.com`,
    "https://service%2eonrender.com",
    "https://service\tonrender.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
  ])
    assert.throws(
      () => stagingOrigin({ ...render, RENDER_EXTERNAL_URL: url }),
      (err) =>
        err instanceof Error &&
        err.message ===
          "Render staging requires a canonical HTTPS RENDER_EXTERNAL_URL and consistent origin settings",
    );
});

test("non-Render tooling keeps exact HTTPS APP_ORIGIN including reserved local test origins", () => {
  for (const APP_ORIGIN of [
    "https://nimclaim-preflight.invalid",
    "https://local.example:8443",
    origin,
  ])
    assert.equal(stagingOrigin({ APP_ORIGIN }), APP_ORIGIN);
});

test("non-Render tooling still refuses missing or inexact APP_ORIGIN", () => {
  for (const APP_ORIGIN of [
    undefined,
    "",
    "http://localhost:5173",
    `${origin}/`,
    `${origin}?a=1`,
    `${origin}#fragment`,
  ])
    assert.throws(
      () => stagingOrigin({ APP_ORIGIN }),
      /exact HTTPS APP_ORIGIN/,
    );
});
