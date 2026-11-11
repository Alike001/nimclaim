import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import { checkPassword, digest, randomToken, verifyOwner } from "../crypto.js";
import { fail } from "../http-contract.js";
import { chain, hashSchema, verifyBasicTransfer, EvidenceMismatch, type Rpc } from "../rpc.js";
import type { Intent, PaymentState, PaymentView, Receipt } from "../../shared/payments.js";

type Row = Record<string, any>;
export class PostgresStore {
  constructor(
    public pool: Pool,
    public origin: string,
    public network: "testnet" | "mainnet" = "testnet",
    public rpc?: Rpc,
  ) {}
  async walletChallenge(
    campaignId: string,
    sessionHash: string,
    organiserId?: string,
  ) {
    return transaction(this.pool, async (c) => {
      if (this.network === "mainnet" && !organiserId)
        fail(401, "Organiser session is required.");
      const campaign = (
        await c.query(
          this.network === "mainnet"
            ? "SELECT * FROM campaigns WHERE id=$1 AND organiser_id=$2 FOR UPDATE"
            : "SELECT * FROM campaigns WHERE id=$1 FOR UPDATE",
          this.network === "mainnet" ? [campaignId, organiserId] : [campaignId],
        )
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
    organiserId?: string,
  ) {
    return transaction(this.pool, async (c) => {
      if (this.network === "mainnet" && !organiserId)
        fail(401, "Organiser session is required.");
      const campaign = (
        await c.query(
          this.network === "mainnet"
            ? "SELECT * FROM campaigns WHERE id=$1 AND organiser_id=$2 FOR UPDATE"
            : "SELECT * FROM campaigns WHERE id=$1 FOR UPDATE",
          this.network === "mainnet" ? [campaignId, organiserId] : [campaignId],
        )
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
  async organiserAuthChallenge(intent: "login" | "register" | "link") {
    if (this.network !== "mainnet")
      fail(404, "Wallet organiser access is available on MAINNET only.");
    const id = randomUUID();
    const expires = Date.now() + 5 * 60_000;
    const purpose = {
      login: "Sign in to your existing NimClaim organiser workspace",
      register: "Create a new NimClaim organiser workspace",
      link: "Link your previous NimClaim organiser workspace",
    }[intent];
    const message = JSON.stringify({
      domain: "NimClaim/organiser/auth/v1",
      intent,
      purpose: `${purpose}. This is a signature only; no transaction or payment.`,
      origin: this.origin,
      network: this.network,
      nonce: randomToken(),
      expires,
    });
    await this.read(
      "INSERT INTO organiser_auth_challenges (id,message,expires) VALUES ($1,$2,$3)",
      [id, message, expires],
    );
    return { id, message, expires, network: this.network };
  }
  async authenticateOrganiser(input: {
    challengeId: string;
    publicKey: string;
    signature: string;
    legacyPassword?: string;
  }) {
    if (this.network !== "mainnet")
      fail(404, "Wallet organiser access is available on MAINNET only.");
    return transaction(this.pool, async (c) => {
      const challenge = (
        await c.query(
          "SELECT * FROM organiser_auth_challenges WHERE id=$1 FOR UPDATE",
          [input.challengeId],
        )
      ).rows[0];
      if (!challenge || challenge.used || challenge.expires <= Date.now())
        fail(
          409,
          "Wallet sign-in request expired or was already used. Try again.",
        );
      let binding: any;
      try {
        binding = JSON.parse(challenge.message);
      } catch {
        fail(409, "Wallet sign-in request is invalid. Try again.");
      }
      if (
        binding.domain !== "NimClaim/organiser/auth/v1" ||
        !["login", "register", "link"].includes(binding.intent) ||
        binding.origin !== this.origin ||
        binding.network !== "mainnet" ||
        binding.expires !== challenge.expires
      )
        fail(409, "Wallet sign-in request belongs to another site or network.");
      const intent = binding.intent as "login" | "register" | "link";
      const expectedPurpose = {
        login: "Sign in to your existing NimClaim organiser workspace",
        register: "Create a new NimClaim organiser workspace",
        link: "Link your previous NimClaim organiser workspace",
      }[intent];
      if (
        binding.purpose !==
          `${expectedPurpose}. This is a signature only; no transaction or payment.` ||
        typeof binding.nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(binding.nonce)
      )
        fail(409, "Wallet sign-in request purpose or nonce is invalid.");
      const publicKey = input.publicKey.toLowerCase();
      const address = verifyOwner(
        challenge.message,
        publicKey,
        input.signature,
      );
      if (!address) fail(401, "Nimiq Pay signature could not be verified.");
      let organiser = (
        await c.query(
          "SELECT id,wallet_address,public_key,legacy,created FROM organisers WHERE wallet_address=$1 FOR UPDATE",
          [address],
        )
      ).rows[0];
      if (intent === "login") {
        if (input.legacyPassword !== undefined)
          fail(400, "Do not enter a previous password when signing in.");
        if (!organiser)
          fail(
            404,
            "No workspace is linked to this wallet. Choose Create a new workspace.",
          );
        if (organiser.public_key !== publicKey)
          fail(401, "This wallet does not match the registered organiser key.");
      } else if (intent === "register") {
        if (input.legacyPassword !== undefined)
          fail(400, "A new workspace does not need a previous password.");
        if (organiser)
          fail(
            409,
            "This wallet already has a workspace. Choose Sign in instead.",
          );
        organiser = (
          await c.query(
            "INSERT INTO organisers (id,wallet_address,public_key,created) VALUES ($1,$2,$3,$4) RETURNING id,wallet_address,public_key,legacy,created",
            [randomUUID(), address, publicKey, Date.now()],
          )
        ).rows[0];
      } else {
        if (organiser)
          fail(409, "This wallet already has a workspace. Sign in instead.");
        const legacyPassword = input.legacyPassword ?? "";
        if (legacyPassword.length === 0)
          fail(
            400,
            "Enter the previous workspace password to link its records.",
          );
        const legacy = (
          await c.query("SELECT password_hash FROM organiser WHERE id=1")
        ).rows[0];
        if (!legacy || !checkPassword(legacyPassword, legacy.password_hash))
          fail(
            401,
            "Previous workspace password is incorrect. No account was linked.",
          );
        const unlinked = (
          await c.query(
            "SELECT id FROM organisers WHERE legacy=true AND wallet_address IS NULL AND public_key IS NULL FOR UPDATE",
          )
        ).rows[0];
        if (!unlinked)
          fail(
            409,
            "The previous workspace has already been linked to a wallet.",
          );
        organiser = (
          await c.query(
            "UPDATE organisers SET wallet_address=$1,public_key=$2 WHERE id=$3 AND wallet_address IS NULL AND public_key IS NULL RETURNING id,wallet_address,public_key,legacy,created",
            [address, publicKey, unlinked.id],
          )
        ).rows[0];
        if (!organiser)
          fail(
            409,
            "The previous workspace was linked elsewhere. Sign in again.",
          );
      }
      const consumed = await c.query(
        "UPDATE organiser_auth_challenges SET used=1 WHERE id=$1 AND used=0 RETURNING id",
        [challenge.id],
      );
      if (consumed.rowCount !== 1)
        fail(409, "Wallet sign-in request was already used. Try again.");
      const token = randomToken();
      await c.query(
        "INSERT INTO sessions (hash,expires,organiser_id) VALUES ($1,$2,$3)",
        [digest(token), Date.now() + 8 * 3600000, organiser.id],
      );
      return {
        token,
        organiser: {
          walletAddress: organiser.wallet_address,
          created: organiser.created,
        },
      };
    });
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
  async issue(campaignId: string, organiserId?: string) {
    return transaction(this.pool, async (c) => {
      // Serializes campaign slot allocation across all API processes.
      if (this.network === "mainnet" && !organiserId)
        fail(401, "Organiser session is required.");
      const campaign = (
        await c.query(
          this.network === "mainnet"
            ? "SELECT * FROM campaigns WHERE id=$1 AND organiser_id=$2 FOR UPDATE"
            : "SELECT * FROM campaigns WHERE id=$1 FOR UPDATE",
          this.network === "mainnet" ? [campaignId, organiserId] : [campaignId],
        )
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
  async decide(id: string, status: string, organiserId?: string) {
    await transaction(this.pool, async (c) => {
      if (this.network === "mainnet" && !organiserId)
        fail(401, "Organiser session is required.");
      const claim = (
        await c.query(
          this.network === "mainnet"
            ? "SELECT a.*,p.expires FROM claims a JOIN campaigns p ON p.id=a.campaign_id WHERE a.id=$1 AND p.organiser_id=$2 FOR UPDATE OF a"
            : "SELECT a.*,p.expires FROM claims a JOIN campaigns p ON p.id=a.campaign_id WHERE a.id=$1 FOR UPDATE OF a",
          this.network === "mainnet" ? [id, organiserId] : [id],
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

  async verifyExternalPayment(
    claimId: string,
    hashInput: string,
    organiserId?: string,
  ) {
    if (this.network !== "mainnet")
      fail(404, "External MAINNET payment verification is unavailable here.");
    if (!organiserId) fail(401, "Organiser session is required.");
    const rpc = this.rpc;
    if (!rpc)
      return fail(503, "MAINNET read-only transaction verification is not configured.");
    const hash = hashSchema.parse(hashInput.toLowerCase());
    const claim = (
      await this.read(
        `SELECT a.id,a.status,a.address,a.campaign_id,p.amount,p.expires,
                w.address AS sender
         FROM claims a
         JOIN campaigns p ON p.id=a.campaign_id
         LEFT JOIN campaign_wallets w ON w.campaign_id=p.id
         WHERE a.id=$1 AND p.organiser_id=$2`,
        [claimId, organiserId],
      )
    )[0];
    if (!claim) fail(404, "Claim not found.");
    if (claim.status !== "payment-ready")
      fail(409, "Only an approved claim can receive a verified payment.");
    if (!claim.sender)
      fail(409, "Authorize the campaign's organiser wallet before verifying payment.");
    const existing = (
      await this.read(
        "SELECT claim_id,hash FROM manual_payment_receipts WHERE claim_id=$1 OR hash=$2",
        [claimId, hash],
      )
    )[0];
    if (existing) {
      if (existing.claim_id === claimId && existing.hash === hash)
        return this.claimView(
          (await this.read("SELECT * FROM claims WHERE id=$1", [claimId]))[0],
        );
      fail(409, "This transaction hash has already been recorded or this claim is already paid.");
    }

    const verification = await verifyBasicTransfer(
      rpc,
      {
        sender: claim.sender,
        recipient: claim.address,
        amount: Number(claim.amount),
        network: "mainnet",
      },
      hash,
      Date.now(),
    ).catch((error) => {
      if (error instanceof EvidenceMismatch) return fail(409, error.message);
      return fail(
        503,
        "MAINNET transaction verification is temporarily unavailable. No payment was recorded.",
      );
    });
    if (verification.state !== "CONFIRMED" || !verification.receipt)
      return fail(409, verification.reason);

    const receipt = verification.receipt;
    try {
      await transaction(this.pool, async (c) => {
      const current = (
        await c.query(
          `SELECT a.id,a.status,a.address,a.campaign_id,p.amount,w.address AS sender
           FROM claims a
           JOIN campaigns p ON p.id=a.campaign_id
           LEFT JOIN campaign_wallets w ON w.campaign_id=p.id
           WHERE a.id=$1 AND p.organiser_id=$2
           FOR UPDATE OF a`,
          [claimId, organiserId],
        )
      ).rows[0];
      if (!current) fail(404, "Claim not found.");
      if (
        current.status !== "payment-ready" ||
        current.address !== claim.address ||
        current.campaign_id !== claim.campaign_id ||
        Number(current.amount) !== Number(claim.amount) ||
        current.sender !== claim.sender
      )
        fail(409, "Claim or campaign payment details changed. Refresh and verify again.");
      const duplicate = (
        await c.query(
          "SELECT claim_id,hash FROM manual_payment_receipts WHERE claim_id=$1 OR hash=$2",
          [claimId, hash],
        )
      ).rows[0];
      if (duplicate)
        fail(409, "This transaction hash has already been recorded or this claim is already paid.");
      await c.query(
        `INSERT INTO manual_payment_receipts
          (id,claim_id,campaign_id,hash,sender,recipient,amount,fee,network,
           validity_start_height,block_number,block_hash,macro_number,macro_hash,verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mainnet',$9,$10,$11,$12,$13,$14)`,
        [
          randomUUID(),
          claimId,
          claim.campaign_id,
          receipt.hash,
          receipt.sender,
          receipt.recipient,
          receipt.amount,
          receipt.fee,
          receipt.validityStartHeight,
          receipt.blockNumber,
          receipt.blockHash,
          receipt.macroNumber,
          receipt.macroHash,
          receipt.verifiedAt,
        ],
      );
      await c.query(
        "INSERT INTO events(claim_id,status,at) VALUES ($1,'paid',$2)",
        [claimId, receipt.verifiedAt],
      );
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      )
        return fail(
          409,
          "This transaction hash has already been recorded or this claim is already paid.",
        );
      throw error;
    }
    return this.claimView(
      (await this.read("SELECT * FROM claims WHERE id=$1", [claimId]))[0],
    );
  }

  private async manualPaymentView(claimId: string): Promise<PaymentView | null> {
    const row = (
      await this.read(
        `SELECT r.*,p.expires
         FROM manual_payment_receipts r
         JOIN campaigns p ON p.id=r.campaign_id
         WHERE r.claim_id=$1`,
        [claimId],
      )
    )[0];
    if (!row) return null;
    const verifiedAt = Number(row.verified_at);
    const reason =
      "External Nimiq Pay transfer independently verified and finalized. NimClaim did not broadcast or custody funds.";
    const receipt: Receipt = {
      hash: row.hash,
      blockNumber: Number(row.block_number),
      validityStartHeight: Number(row.validity_start_height),
      blockHash: row.block_hash,
      macroNumber: Number(row.macro_number),
      macroHash: row.macro_hash,
      executionResult: true,
      verifiedAt,
      sender: row.sender,
      recipient: row.recipient,
      amount: Number(row.amount),
      fee: Number(row.fee),
      network: "mainnet",
      source: "external",
    };
    const intent: Intent = {
      id: row.id,
      claim_id: row.claim_id,
      campaign_id: row.campaign_id,
      sender: row.sender,
      recipient: row.recipient,
      amount: Number(row.amount),
      fee: Number(row.fee),
      network: "mainnet",
      validity_start_height: Number(row.validity_start_height),
      created: verifiedAt,
      expires: Number(row.expires),
    };
    return {
      intent,
      id: row.id,
      state: "CONFIRMED",
      reason,
      candidateHash: row.hash,
      receipt,
      explorerUrl: `${chain.mainnet.explorer}/#${row.hash}`,
      history: [{ state: "CONFIRMED", reason, at: verifiedAt }],
    };
  }

  async claimView(claim: Row | undefined) {
    if (!claim) return null;
    return {
      id: claim.id,
      address: claim.address,
      status: claim.status,
      created: claim.created,
      payment:
        this.network === "mainnet"
          ? await this.manualPaymentView(claim.id)
          : await this.paymentView(claim.id),
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
