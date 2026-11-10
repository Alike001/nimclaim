import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import { digest, randomToken, verifyOwner } from "../crypto.js";
import { fail } from "../http-contract.js";
import { chain } from "../rpc.js";
import type { Intent, PaymentState, Receipt } from "../../shared/payments.js";

type Row = Record<string, any>;
export class PostgresStore {
  constructor(
    public pool: Pool,
    public origin: string,
    public network: "testnet" | "mainnet" = "testnet",
  ) {}
  async walletChallenge(campaignId: string, sessionHash: string) {
    return transaction(this.pool, async (c) => {
      const campaign = (
        await c.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [
          campaignId,
        ])
      ).rows[0];
      if (!campaign) fail(404, "Campaign not found.");
      if (campaign.expires <= Date.now()) fail(410, "Campaign has expired.");
      if (
        (
          await c.query(
            "SELECT address FROM campaign_wallets WHERE campaign_id=$1",
            [campaignId],
          )
        ).rowCount
      )
        fail(409, "Campaign wallet is already authorized and immutable.");
      await c.query(
        "UPDATE organiser_challenges SET used=1 WHERE campaign_id=$1 AND session_hash=$2 AND purpose='bind' AND used=0",
        [campaignId, sessionHash],
      );
      const id = randomUUID(),
        expires = Math.min(Date.now() + 300000, campaign.expires);
      const message = JSON.stringify({
        domain: "NimClaim/organiser/bind/v1",
        purpose:
          "Authorize this signing wallet for this campaign; no payment or transaction",
        origin: this.origin,
        network: this.network,
        details: { campaign: campaignId, amountLuna: campaign.amount },
        nonce: randomToken(),
        expires,
      });
      await c.query(
        "INSERT INTO organiser_challenges(id,campaign_id,session_hash,purpose,message,expires) VALUES ($1,$2,$3,'bind',$4,$5)",
        [id, campaignId, sessionHash, message, expires],
      );
      return { id, message, expires };
    });
  }
  async bindWallet(
    campaignId: string,
    sessionHash: string,
    input: { challengeId: string; publicKey: string; signature: string },
  ) {
    return transaction(this.pool, async (c) => {
      const campaign = (
        await c.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [
          campaignId,
        ])
      ).rows[0];
      if (!campaign) fail(404, "Campaign not found.");
      if (campaign.expires <= Date.now()) fail(410, "Campaign has expired.");
      if (
        (
          await c.query(
            "SELECT address FROM campaign_wallets WHERE campaign_id=$1",
            [campaignId],
          )
        ).rowCount
      )
        fail(409, "Campaign wallet is already authorized and immutable.");
      const challenge = (
        await c.query(
          "SELECT * FROM organiser_challenges WHERE id=$1 AND campaign_id=$2 AND session_hash=$3 AND purpose='bind' FOR UPDATE",
          [input.challengeId, campaignId, sessionHash],
        )
      ).rows[0];
      if (!challenge || challenge.used || challenge.expires <= Date.now())
        fail(409, "Signing request expired or consumed.");
      const binding = JSON.parse(challenge.message);
      if (
        binding.origin !== this.origin ||
        binding.network !== this.network ||
        binding.domain !== "NimClaim/organiser/bind/v1" ||
        binding.details.campaign !== campaignId ||
        binding.details.amountLuna !== campaign.amount
      )
        fail(409, "Signing request binding mismatch.");
      const address = verifyOwner(
        challenge.message,
        input.publicKey,
        input.signature,
      );
      if (!address) fail(401, "Wallet signature is invalid.");
      await c.query("INSERT INTO campaign_wallets VALUES ($1,$2,$3,$4,$5,$6)", [
        campaignId,
        address,
        input.publicKey,
        input.signature,
        challenge.id,
        Date.now(),
      ]);
      await c.query(
        "UPDATE organiser_challenges SET used=1 WHERE id=$1 AND used=0",
        [challenge.id],
      );
      return { address };
    });
  }
  async read(sql: string, args: unknown[] = []) {
    return transaction(this.pool, async (c) => (await c.query(sql, args)).rows);
  }
  async rate(login: boolean) {
    // Atomic UPSERT persists the increment even when the HTTP request is rejected.
    // Server time avoids disagreement between overlapping processes.
    const rows = await this.read(
      `INSERT INTO staging_rate VALUES ($1,1,(extract(epoch FROM clock_timestamp())*1000)::bigint+60000)
      ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN staging_rate.until <= (extract(epoch FROM clock_timestamp())*1000)::bigint THEN 1 ELSE LEAST(staging_rate.count+1,1000000) END,
      until=CASE WHEN staging_rate.until <= (extract(epoch FROM clock_timestamp())*1000)::bigint THEN EXCLUDED.until ELSE staging_rate.until END RETURNING count`,
      [login ? "login" : "api"],
    );
    if (rows[0].count > (login ? 10 : 180))
      fail(429, "Too many requests. Try again in a minute.");
  }
  async expire() {
    // One SQL statement: status transition and its history entry commit together.
    await this.read(`WITH expired AS (
      UPDATE claims SET status='expired' FROM campaigns c WHERE c.id=claims.campaign_id
      AND claims.status='pending' AND c.expires <= (extract(epoch FROM clock_timestamp())*1000)::bigint
      RETURNING claims.id,c.expires)
      INSERT INTO events(claim_id,status,at) SELECT id,'expired',expires FROM expired`);
  }
  private async invitation(c: PoolClient, token: string) {
    // Campaign rows never change. Lock the invitation before creating/replacing/consuming its nonce.
    const inv = (
      await c.query(
        `SELECT i.*,p.expires,p.amount FROM invitations i JOIN campaigns p ON p.id=i.campaign_id
      WHERE i.token_hash=$1 FOR UPDATE OF i`,
        [digest(token)],
      )
    ).rows[0];
    if (!inv) fail(404, "Invitation not found. Check your link.");
    return inv as Row;
  }
  private async usable(c: PoolClient, inv: Row, now: number) {
    if (inv.expires <= now) fail(410, "This invitation has expired.");
    if (
      (await c.query("SELECT id FROM claims WHERE invitation_id=$1", [inv.id]))
        .rowCount
    )
      fail(409, "This invitation has already been used.");
  }
  async issue(campaignId: string) {
    return transaction(this.pool, async (c) => {
      // Serializes campaign slot allocation across all API processes.
      const campaign = (
        await c.query("SELECT * FROM campaigns WHERE id=$1 FOR UPDATE", [
          campaignId,
        ])
      ).rows[0];
      if (!campaign) fail(404, "Campaign not found.");
      if (campaign.expires <= Date.now()) fail(410, "Campaign has expired.");
      const count = (
        await c.query(
          "SELECT count(*) AS n FROM invitations WHERE campaign_id=$1",
          [campaignId],
        )
      ).rows[0].n;
      if (count >= campaign.slots)
        fail(409, "All reward slots have an invitation.");
      const id = randomUUID(),
        token = randomToken();
      await c.query("INSERT INTO invitations VALUES ($1,$2,$3,$4)", [
        id,
        campaignId,
        digest(token),
        Date.now(),
      ]);
      return { id, url: `${this.origin}/#claim=${token}` };
    });
  }
  async challenge(token: string) {
    return transaction(this.pool, async (c) => {
      const inv = await this.invitation(c, token),
        now = Date.now();
      await this.usable(c, inv, now);
      await c.query(
        "UPDATE challenges SET used=1 WHERE invitation_id=$1 AND used=0",
        [inv.id],
      );
      const id = randomUUID(),
        expires = Math.min(now + 300000, inv.expires);
      const message = JSON.stringify({
        domain: "NimClaim/claim/v1",
        purpose: "Request a contributor reward; no payment or transaction",
        origin: this.origin,
        network: this.network,
        campaign: inv.campaign_id,
        invitation: inv.id,
        tokenHash: digest(token),
        amountLuna: inv.amount,
        nonce: randomToken(),
        expires,
      });
      await c.query(
        "INSERT INTO challenges(id,invitation_id,message,expires) VALUES ($1,$2,$3,$4)",
        [id, inv.id, message, expires],
      );
      return { id, message, expires, network: this.network };
    });
  }
  async claim(input: {
    token: string;
    challengeId: string;
    publicKey: string;
    signature: string;
  }) {
    return transaction(this.pool, async (c) => {
      const inv = await this.invitation(c, input.token),
        now = Date.now();
      await this.usable(c, inv, now);
      const challenge = (
        await c.query(
          "SELECT * FROM challenges WHERE id=$1 AND invitation_id=$2 FOR UPDATE",
          [input.challengeId, inv.id],
        )
      ).rows[0];
      if (!challenge || challenge.used || challenge.expires <= now)
        fail(
          409,
          "Signing request is expired or already used. Request a new one.",
        );
      const binding = JSON.parse(challenge.message);
      if (binding.origin !== this.origin || binding.network !== this.network)
        fail(
          409,
          "Signing request belongs to a different origin or network. Request a new one.",
        );
      const address = verifyOwner(
        challenge.message,
        input.publicKey,
        input.signature,
      );
      if (!address) fail(401, "Wallet signature is invalid.");
      const id = randomUUID();
      // UNIQUE(campaign,address), invitation and challenge are the final arbiter.
      // Competing invitations need no common application mutex.
      await c.query(
        "INSERT INTO claims VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)",
        [
          id,
          inv.id,
          inv.campaign_id,
          address,
          input.publicKey,
          input.signature,
          challenge.id,
          now,
        ],
      );
      const consumed = await c.query(
        "UPDATE challenges SET used=1 WHERE id=$1 AND used=0 RETURNING id",
        [challenge.id],
      );
      if (consumed.rowCount !== 1)
        fail(409, "Signing request already consumed.");
      await c.query(
        "INSERT INTO events(claim_id,status,at) VALUES ($1,'pending',$2)",
        [id, now],
      );
      return {
        id,
        address,
        status: "pending",
        created: now,
        payment: null,
        history: [{ status: "pending", at: now }],
      };
    });
  }
  async decide(id: string, status: string) {
    await transaction(this.pool, async (c) => {
      const claim = (
        await c.query(
          "SELECT a.*,p.expires FROM claims a JOIN campaigns p ON p.id=a.campaign_id WHERE a.id=$1 FOR UPDATE OF a",
          [id],
        )
      ).rows[0];
      if (!claim) fail(404, "Claim not found.");
      const now = Date.now();
      if (claim.status !== "pending" || claim.expires <= now)
        fail(409, "Only an unexpired pending claim can be reviewed.");
      const result = await c.query(
        "UPDATE claims SET status=$1 WHERE id=$2 AND status='pending' RETURNING id",
        [status, id],
      );
      if (result.rowCount !== 1) fail(409, "Claim already reviewed.");
      await c.query(
        "INSERT INTO events(claim_id,status,at) VALUES ($1,$2,$3)",
        [id, status, now],
      );
    });
    return this.claimView(
      (await this.read("SELECT * FROM claims WHERE id=$1", [id]))[0],
    );
  }
  async claimView(claim: Row | undefined) {
    if (!claim) return null;
    return {
      id: claim.id,
      address: claim.address,
      status: claim.status,
      created: claim.created,
      payment:
        this.network === "mainnet" ? null : await this.paymentView(claim.id),
      history: await this.read(
        "SELECT status,at FROM events WHERE claim_id=$1 ORDER BY id",
        [claim.id],
      ),
    };
  }
  private async paymentView(claimId: string) {
    // Existing attempt records remain locked; stale SUBMITTING becomes UNKNOWN atomically.
    await this.read(
      `WITH stale AS (
      UPDATE payment_attempts a SET state='UNKNOWN',reason='Dispatch window expired; do not retry.',updated=$2
      FROM payment_intents i WHERE a.intent_id=i.id AND i.claim_id=$1 AND i.expires<=$2 AND a.state='SUBMITTING'
      RETURNING a.id,a.reason,a.updated)
      INSERT INTO payment_events(attempt_id,state,reason,at) SELECT id,'UNKNOWN',reason,updated FROM stale`,
      [claimId, Date.now()],
    );
    const intent = (
      await this.read("SELECT * FROM payment_intents WHERE claim_id=$1", [
        claimId,
      ])
    )[0] as Intent | undefined;
    if (!intent) return null;
    const attempt = (
      await this.read("SELECT * FROM payment_attempts WHERE intent_id=$1", [
        intent.id,
      ])
    )[0];
    if (!attempt) throw new Error("Missing durable attempt");
    const receipt: Receipt | null = attempt.receipt
      ? JSON.parse(attempt.receipt)
      : null;
    return {
      intent,
      id: attempt.id,
      state: attempt.state as PaymentState,
      reason: attempt.reason,
      candidateHash: attempt.candidate_hash,
      receipt,
      explorerUrl: receipt
        ? `${chain[intent.network].explorer}/#${receipt.hash}`
        : null,
      history: await this.read(
        "SELECT state,reason,at FROM payment_events WHERE attempt_id=$1 ORDER BY id",
        [attempt.id],
      ),
    };
  }
}
