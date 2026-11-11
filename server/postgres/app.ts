import type { PaymentGate } from "../../shared/payments.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PostgresStore } from "./store.js";
import {
  ApiError,
  fail,
  tokenSchema,
  tokenBody,
  campaignSchema,
  readJson,
  serveStatic,
  securityHeaders,
} from "../http-contract.js";
import { checkPassword, digest, randomToken } from "../crypto.js";

const disabledGate: PaymentGate = {
  enabled: false,
  senderBindingSupported: false,
  htlcVerificationSupported: false,
  reasons: ["Spending is permanently disabled in TESTNET staging."],
};
export function createPostgresApp(store: PostgresStore, staticDir = "./dist") {
  if (
    new URL(store.origin).origin !== store.origin ||
    !store.origin.startsWith("https://")
  )
    throw new Error("Postgres staging requires an exact HTTPS origin");
  const mainnet = store.network === "mainnet";
  const gate = mainnet
    ? {
        ...disabledGate,
        reasons: [
          "MAINNET spending and payment verification are unavailable. Approved claims remain unpaid.",
        ],
      }
    : disabledGate;
  const sessionName = mainnet ? "nimclaim_mainnet_session" : "nimclaim_session";
  const server = createServer(async (req, res) => {
    securityHeaders(res, store.origin);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url ?? "/", store.origin).pathname;
      if (path === "/healthz" && req.method === "GET")
        return send(200, { ready: true });
      if (!path.startsWith("/api/")) return serveStatic(path, res, staticDir);
      if (!["GET", "POST"].includes(req.method ?? ""))
        fail(405, "Method not allowed.");
      if (
        /^\/api\/payments(?:\/|$)/.test(path) ||
        /^\/api\/claims\/[^/]+\/payment(?:\/|$)/.test(path) ||
        (!mainnet && /^\/api\/campaigns\/[^/]+\/wallet(?:\/|$)/.test(path))
      )
        fail(
          403,
          mainnet
            ? "MAINNET payments are unavailable; claims remain unpaid."
            : "Payments are unavailable in staging.",
        );
      await store.rate(path === "/api/login");
      let body: any;
      if (req.method === "POST") {
        if (req.headers.origin !== store.origin)
          fail(403, "Request origin is not allowed.");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          fail(415, "JSON required.");
        body = await readJson(req);
      }
      if (path === "/api/config" && req.method === "GET")
        return send(200, {
          network: store.network,
          origin: store.origin,
          staging: !mainnet,
          ...(mainnet ? { claimsOnly: true } : {}),
          mobileTest: false,
        });
      await store.expire();
      const session = new RegExp(
        `(?:^|;\\s*)${sessionName}=([a-f0-9]{64})(?:;|$)`,
      ).exec(req.headers.cookie ?? "")?.[1];
      const sessionRow = session
        ? (
            await store.read(
              mainnet
                ? "SELECT s.hash,s.organiser_id,o.wallet_address FROM sessions s JOIN organisers o ON o.id=s.organiser_id WHERE s.hash=$1 AND s.expires>$2 AND o.wallet_address IS NOT NULL"
                : "SELECT hash FROM sessions WHERE hash=$1 AND expires>$2",
              [digest(session), Date.now()],
            )
          )[0]
        : undefined;
      const authorised = !!sessionRow;
      const organiserId = mainnet ? sessionRow?.organiser_id : undefined;
      if (path === "/api/session" && req.method === "GET")
        return send(200, {
          authenticated: authorised,
          ...(mainnet && sessionRow
            ? { walletAddress: sessionRow.wallet_address }
            : {}),
        });
      const cookie = (value: string, age: number) =>
        `${sessionName}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}; Secure`;
      if (mainnet && path === "/api/auth/challenge" && req.method === "POST") {
        const { intent } = z
          .object({ intent: z.enum(["login", "register", "link"]) })
          .strict()
          .parse(body);
        return send(201, await store.organiserAuthChallenge(intent));
      }
      if (mainnet && path === "/api/auth/verify" && req.method === "POST") {
        const proof = z
          .object({
            challengeId: z.string().uuid(),
            publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
            signature: z.string().regex(/^[a-f0-9]{128}$/i),
            legacyPassword: z.string().min(1).max(256).optional(),
          })
          .strict()
          .parse(body);
        const result = await store.authenticateOrganiser(proof);
        res.setHeader("Set-Cookie", cookie(result.token, 8 * 3600));
        return send(200, {
          authenticated: true,
          organiser: result.organiser,
        });
      }
      if (path === "/api/login" && req.method === "POST") {
        if (mainnet) fail(404, "Use Nimiq Pay wallet sign-in.");
        const { password } = z
          .object({ password: z.string().min(1).max(256) })
          .strict()
          .parse(body);
        const organiser = (
          await store.read("SELECT password_hash FROM organiser WHERE id=1")
        )[0];
        if (!organiser || !checkPassword(password, organiser.password_hash))
          fail(401, "Invalid organiser credentials.");
        const token = randomToken();
        await store.read("INSERT INTO sessions VALUES ($1,$2)", [
          digest(token),
          Date.now() + 8 * 3600000,
        ]);
        res.setHeader("Set-Cookie", cookie(token, 8 * 3600));
        return send(200, { authenticated: true });
      }
      if (path === "/api/logout" && req.method === "POST") {
        if (session)
          await store.read("UPDATE sessions SET expires=0 WHERE hash=$1", [
            digest(session),
          ]);
        res.setHeader("Set-Cookie", cookie("", 0));
        return send(200, { authenticated: false });
      }
      if (path === "/api/invitation" && req.method === "POST") {
        const { token } = tokenBody.parse(body);
        const inv = (
          await store.read("SELECT * FROM invitations WHERE token_hash=$1", [
            digest(token),
          ])
        )[0];
        if (!inv) fail(404, "Invitation not found. Check your link.");
        const campaign = (
          await store.read(
            "SELECT id,title,description,amount,slots,expires,created FROM campaigns WHERE id=$1",
            [inv.campaign_id],
          )
        )[0];
        return send(200, {
          campaign,
          expired: campaign.expires <= Date.now(),
          claim: await store.claimView(
            (
              await store.read("SELECT * FROM claims WHERE invitation_id=$1", [
                inv.id,
              ])
            )[0],
          ),
        });
      }
      if (path === "/api/challenge" && req.method === "POST")
        return send(201, await store.challenge(tokenBody.parse(body).token));
      if (path === "/api/claim" && req.method === "POST") {
        const input = z
          .object({
            token: tokenSchema,
            challengeId: z.string().uuid(),
            publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
            signature: z.string().regex(/^[a-f0-9]{128}$/i),
          })
          .strict()
          .parse(body);
        return send(201, { claim: await store.claim(input) });
      }
      if (!authorised) fail(401, "Sign in as organiser to continue.");
      const walletRoute =
        /^\/api\/campaigns\/([a-f0-9-]{36})\/wallet(\/challenge)?$/.exec(path);
      if (mainnet && walletRoute && req.method === "POST") {
        if (walletRoute[2]) {
          z.object({}).strict().parse(body);
          return send(
            201,
            await store.walletChallenge(
              walletRoute[1],
              digest(session!),
              organiserId,
            ),
          );
        }
        const proof = z
          .object({
            challengeId: z.string().uuid(),
            publicKey: z.string().regex(/^[a-f0-9]{64}$/i),
            signature: z.string().regex(/^[a-f0-9]{128}$/i),
          })
          .strict()
          .parse(body);
        return send(201, {
          wallet: await store.bindWallet(
            walletRoute[1],
            digest(session!),
            proof,
            organiserId,
          ),
        });
      }
      if (path === "/api/campaigns" && req.method === "GET")
        return send(200, {
          campaigns: await store.read(
            mainnet
              ? `SELECT c.id,c.title,c.description,c.amount,c.slots,c.expires,c.created,(SELECT count(*) FROM invitations WHERE campaign_id=c.id) AS issued,(SELECT count(*) FROM claims WHERE campaign_id=c.id) AS claimed FROM campaigns c WHERE c.organiser_id=$1 ORDER BY created DESC`
              : `SELECT c.id,c.title,c.description,c.amount,c.slots,c.expires,c.created,(SELECT count(*) FROM invitations WHERE campaign_id=c.id) AS issued,(SELECT count(*) FROM claims WHERE campaign_id=c.id) AS claimed FROM campaigns c ORDER BY created DESC`,
            mainnet ? [organiserId] : [],
          ),
        });
      if (path === "/api/campaigns" && req.method === "POST") {
        const input = campaignSchema.parse(body),
          now = Date.now();
        if (input.expires <= now || input.expires > now + 366 * 86400000)
          fail(400, "Expiry must be in the future, within one year.");
        const [whole, fraction = ""] = input.amount.split(".");
        const amount = Number(whole) * 100000 + Number(fraction.padEnd(5, "0"));
        if (!Number.isSafeInteger(amount))
          fail(400, "Amount is outside the safe integer range.");
        const campaign = (
          await store.read(
            mainnet
              ? "INSERT INTO campaigns (id,title,description,amount,slots,expires,created,organiser_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title,description,amount,slots,expires,created"
              : "INSERT INTO campaigns VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,description,amount,slots,expires,created",
            mainnet
              ? [
                  randomUUID(),
                  input.title,
                  input.description,
                  amount,
                  input.slots,
                  input.expires,
                  now,
                  organiserId,
                ]
              : [
                  randomUUID(),
                  input.title,
                  input.description,
                  amount,
                  input.slots,
                  input.expires,
                  now,
                ],
          )
        )[0];
        return send(201, { campaign });
      }
      const detail = /^\/api\/campaigns\/([a-f0-9-]{36})$/.exec(path);
      if (detail && req.method === "GET") {
        const campaign = (
          await store.read(
            mainnet
              ? "SELECT id,title,description,amount,slots,expires,created FROM campaigns WHERE id=$1 AND organiser_id=$2"
              : "SELECT id,title,description,amount,slots,expires,created FROM campaigns WHERE id=$1",
            mainnet ? [detail[1], organiserId] : [detail[1]],
          )
        )[0];
        if (!campaign) fail(404, "Campaign not found.");
        const claims = [];
        for (const claim of await store.read(
          "SELECT * FROM claims WHERE campaign_id=$1 ORDER BY created",
          [detail[1]],
        ))
          claims.push(await store.claimView(claim));
        return send(200, {
          campaign,
          staging: !mainnet,
          ...(mainnet ? { claimsOnly: true } : {}),
          wallet:
            (
              await store.read(
                "SELECT address,created FROM campaign_wallets WHERE campaign_id=$1",
                [detail[1]],
              )
            )[0] ?? null,
          paymentGate: gate,
          invitations: await store.read(
            "SELECT id,created FROM invitations WHERE campaign_id=$1 ORDER BY created",
            [detail[1]],
          ),
          claims,
        });
      }
      const invite = /^\/api\/campaigns\/([a-f0-9-]{36})\/invitations$/.exec(
        path,
      );
      if (invite && req.method === "POST") {
        z.object({}).strict().parse(body);
        return send(
          201,
          await store.issue(invite[1], mainnet ? organiserId : undefined),
        );
      }
      const decision = /^\/api\/claims\/([a-f0-9-]{36})\/decision$/.exec(path);
      if (decision && req.method === "POST") {
        const { decision: status } = z
          .object({ decision: z.enum(["payment-ready", "rejected"]) })
          .strict()
          .parse(body);
        return send(200, {
          claim: await store.decide(
            decision[1],
            status,
            mainnet ? organiserId : undefined,
          ),
        });
      }
      fail(404, "Endpoint not found.");
    } catch (error) {
      if (error instanceof ApiError)
        send(error.status, { error: error.message });
      else if (error instanceof z.ZodError)
        send(400, {
          error: "Invalid input. Check the required fields and formats.",
        });
      else if (
        ["23505", "40001", "40P01", "55P03"].includes(
          (error as { code?: string })?.code ?? "",
        )
      )
        send(409, {
          error:
            "Request conflicts with another operation. Refresh before retrying.",
        });
      else {
        console.error("Postgres request unavailable");
        send(503, {
          error:
            "Service temporarily unavailable. Refresh status before retrying.",
        });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
