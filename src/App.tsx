import { WalletDiagnostics } from "./WalletDiagnostics";
import { CampaignWallet, Payout, PaymentStatus } from "./Payments";
import type { PaymentGate } from "../shared/payments";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  api,
  nim,
  date,
  statusLabel,
  claimStatus,
  type Campaign,
  type Claim,
} from "./api";
import {
  connectWallet,
  signChallenge,
  walletError,
  watchWalletAccounts,
} from "./wallet";

type Config = {
  network: string;
  origin: string;
  staging?: boolean;
  claimsOnly?: boolean;
};
function reviewLabel(status: string, staging?: boolean, claimsOnly?: boolean) {
  if (staging && status === "payment-ready") return "Approved for testing";
  if (claimsOnly && status === "payment-ready") return "Approved · unpaid";
  return statusLabel(status);
}
function History({
  claim,
  staging,
  claimsOnly,
}: {
  claim: Claim;
  staging?: boolean;
  claimsOnly?: boolean;
}) {
  return (
    <ol className="history">
      {claim.history.map((event, i) => (
        <li key={i}>
          <strong>{reviewLabel(event.status, staging, claimsOnly)}</strong>
          <time dateTime={new Date(event.at).toISOString()}>
            {date(event.at)}
          </time>
        </li>
      ))}
    </ol>
  );
}
function Badge({
  status,
  staging,
  claimsOnly,
}: {
  status: string;
  staging?: boolean;
  claimsOnly?: boolean;
}) {
  return (
    <span className={`badge ${status}`}>
      {reviewLabel(status, staging, claimsOnly)}
    </span>
  );
}
function Notice({ text }: { text: string }) {
  return text ? (
    <p className="notice" role="alert">
      {text}
    </p>
  ) : null;
}

function Landing({
  network,
  claimsOnly,
}: {
  network: string;
  claimsOnly?: boolean;
}) {
  return (
    <section className="landing" aria-label="About NimClaim">
      <div className="landing-hero">
        <div className="landing-copy">
          <p className="eyebrow landing-kicker">
            Verified contribution claims for Nimiq communities
          </p>
          <h1>
            Recognise the work.
            <br />
            <span>Verify the claim.</span>
          </h1>
          <p className="landing-lede">
            Create a campaign, invite contributors privately, and review real
            Nimiq Pay wallet signatures. NimClaim records claim decisions; it
            does not transfer NIM.
          </p>
          <div className="landing-actions">
            <a className="landing-primary" href="#organiser-access">
              {claimsOnly ? "Create or access workspace" : "Organiser sign in"}{" "}
              <span aria-hidden="true">↗</span>
            </a>
            <a className="landing-secondary" href="#workflow">
              How it works
            </a>
          </div>
          <p className="landing-hint">
            <strong>Contributor?</strong> In Nimiq Pay, open Mini Apps → Custom
            URL and paste your complete invitation link. No account or organiser
            password is needed.
          </p>
        </div>
        <aside className="landing-preview" aria-label="Reward claim workflow">
          <div className="landing-preview-head">
            <span>CLAIM WORKFLOW</span>
            <span className="landing-preview-network">
              {network.toUpperCase()}
            </span>
          </div>
          <div className="landing-preview-body">
            <p className="landing-preview-caption">
              Every approval has a history.
            </p>
            <div className="landing-preview-step">
              <span className="landing-step-number">01</span>
              <div>
                <strong>Private invitation</strong>
                <span>One link, one reward slot</span>
              </div>
              <span className="landing-step-check" aria-hidden="true">
                ✓
              </span>
            </div>
            <div className="landing-preview-step">
              <span className="landing-step-number">02</span>
              <div>
                <strong>Verified wallet signature</strong>
                <span>No transfer required to claim</span>
              </div>
              <span className="landing-step-check" aria-hidden="true">
                ✓
              </span>
            </div>
            <div className="landing-preview-step">
              <span className="landing-step-number">03</span>
              <div>
                <strong>Organiser review</strong>
                <span>Approved · unpaid</span>
              </div>
              <span className="landing-unpaid">UNPAID</span>
            </div>
          </div>
          <div className="landing-preview-foot">
            <span className="landing-foot-dot" aria-hidden="true" />
            Claims and signatures are real. Payment is not implied.
          </div>
        </aside>
      </div>
      <div className="landing-workflow" id="workflow">
        <div className="landing-section-title">
          <p className="eyebrow">Simple by design</p>
          <h2>From contribution to reviewed claim.</h2>
          <p>No wallet password is shared with NimClaim.</p>
        </div>
        <div className="landing-features">
          <article className="landing-feature">
            <span className="landing-feature-icon" aria-hidden="true">
              ✦
            </span>
            <h3>01 / Create</h3>
            <p>
              Set a campaign title, reward commitment, available slots and
              expiry, then issue private contributor invitations.
            </p>
          </article>
          <article className="landing-feature">
            <span className="landing-feature-icon" aria-hidden="true">
              ◇
            </span>
            <h3>02 / Verify</h3>
            <p>
              Contributors sign a one-time message in Nimiq Pay. No NIM is spent
              to claim.
            </p>
          </article>
          <article className="landing-feature">
            <span className="landing-feature-icon" aria-hidden="true">
              ✓
            </span>
            <h3>03 / Review</h3>
            <p>
              Organisers review and approve or reject claims. Everyone can see
              the resulting status.
            </p>
          </article>
        </div>
      </div>
      <div className="landing-trust" role="note">
        <div>
          <strong>Transparency, not a payment promise.</strong>
          <p>
            {claimsOnly
              ? "MAINNET supports signed claims and organiser review only. NimClaim does not send, track or verify NIM payouts."
              : "Approval marks a reward as ready for payment, not paid. Native sending remains blocked pending sender-binding and independent settlement verification."}
          </p>
        </div>
        <a href="#organiser-access">
          Organiser access <span aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  );
}

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState("");
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    api<Config>("/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
    const change = () => setHash(location.hash);
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const token = /^#claim=([a-f0-9]{64})$/.exec(hash)?.[1];
  return (
    <>
      <header>
        <a className="brand" href="#">
          <span aria-hidden="true" className="mark">
            N
          </span>
          NimClaim
        </a>
        <div className="header-actions">
          {!hash.startsWith("#claim=") && hash !== "#diagnostics" && (
            <a
              className="header-access"
              href="#organiser-access"
              aria-label="Open organiser workspace"
            >
              Workspace
            </a>
          )}
          <span className="network">
            {config?.network.toUpperCase() ?? "Connecting…"}
          </span>
        </div>
      </header>
      <main>
        {config?.claimsOnly && (
          <p className="notice" role="status">
            MAINNET · Real wallet signatures and reward claims. Payments are
            unavailable; approval does not transfer NIM.
          </p>
        )}
        <Notice text={error} />
        {config &&
          (hash === "#diagnostics" ? (
            config.staging || config.claimsOnly ? (
              <section className="panel">
                <h1>Page unavailable</h1>
                <p>
                  {config.staging
                    ? "Open your private invitation for TESTNET claim testing."
                    : "Open your private invitation to submit a signed claim."}
                </p>
              </section>
            ) : (
              <>
                <h1>Private device check</h1>
                <WalletDiagnostics expectedNetwork={config.network} />
              </>
            )
          ) : hash.startsWith("#claim=") ? (
            token ? (
              <Recipient key={token} token={token} config={config} />
            ) : (
              <section className="panel">
                <h1>Invalid invitation</h1>
                <p>
                  Check that you opened the complete link from your organiser.
                </p>
              </section>
            )
          ) : (
            <Organiser
              staging={config.staging}
              claimsOnly={config.claimsOnly}
              network={config.network}
              showLanding={hash !== "#organiser-access"}
            />
          ))}
      </main>
      <footer>
        {config?.staging ? (
          "TESTNET claim testing only. Native NIM spending is disabled."
        ) : config?.claimsOnly ? (
          "MAINNET claims only. NimClaim does not send or verify payments."
        ) : (
          <>
            Native NIM rewards.{" "}
            <strong>Native spending is gated on the server.</strong>
            <br />
            Nimiq chain data is public. Approval is not proof of payment.
          </>
        )}
      </footer>
    </>
  );
}
function Organiser({
  staging,
  claimsOnly,
  network,
  showLanding,
}: {
  staging?: boolean;
  claimsOnly?: boolean;
  network: string;
  showLanding: boolean;
}) {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [legacyPassword, setLegacyPassword] = useState("");
  const load = useCallback(async () => {
    const r = await api("/campaigns");
    setCampaigns(r.campaigns);
  }, []);
  useEffect(() => {
    api("/session")
      .then((r) => {
        setAuthenticated(r.authenticated);
        setWalletAddress(r.walletAddress ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (authenticated) load().catch((e) => setError(e.message));
  }, [authenticated, load]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    setBusy(true);
    setError("");
    try {
      await api("/login", { password });
      setWalletAddress(null);
      setAuthenticated(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function walletLogin() {
    setBusy(true);
    setError("");
    try {
      const connected = await connectWallet(network);
      const challenge = await api<{
        id: string;
        message: string;
        expires: number;
      }>("/auth/challenge", {});
      const signed = await signChallenge(
        connected.provider,
        challenge.message,
        network,
        connected.walletAddress,
      );
      const result = await api<{
        authenticated: boolean;
        organiser: { walletAddress: string; created: number };
      }>("/auth/verify", {
        challengeId: challenge.id,
        publicKey: signed.publicKey,
        signature: signed.signature,
        ...(legacyPassword ? { legacyPassword } : {}),
      });
      setWalletAddress(result.organiser.walletAddress);
      setLegacyPassword("");
      setAuthenticated(result.authenticated);
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  if (authenticated === undefined)
    return <p role="status">Loading organiser session…</p>;
  if (!authenticated)
    return (
      <>
        {showLanding && <Landing network={network} claimsOnly={claimsOnly} />}
        {claimsOnly ? (
          <section
            className="panel auth"
            id="organiser-access"
            aria-labelledby="organiser-access-title"
          >
            <p className="eyebrow">Public organiser access</p>
            <h1 id="organiser-access-title">Create or access your workspace</h1>
            <p>
              Use Nimiq Pay to create a new organiser account or return to your
              existing workspace. Your wallet signs a one-time login message;
              NimClaim never receives your PIN, recovery phrase or private key.
            </p>
            <button
              className="wallet-login"
              type="button"
              onClick={walletLogin}
              disabled={busy}
            >
              {busy ? "Waiting for Nimiq Pay…" : "Continue with Nimiq Pay"}
            </button>
            <p className="auth-help">
              New wallet? Your private workspace is created automatically.
              Returning wallet? Your campaigns will be waiting for you.
            </p>
            <details className="auth-legacy-link">
              <summary>Already used NimClaim? Link your previous workspace</summary>
              <p>
                If you created campaigns on the original single-organiser
                version, enter its one-time workspace password here. Your old
                campaigns and claims will stay with that workspace. You only
                need this password once.
              </p>
              <label htmlFor="legacy-workspace-password">
                Previous workspace password
              </label>
              <input
                id="legacy-workspace-password"
                type="password"
                autoComplete="current-password"
                maxLength={256}
                value={legacyPassword}
                onChange={(event) => setLegacyPassword(event.target.value)}
              />
              <p className="auth-help">
                Leave this empty to create a new workspace. Never enter your
                Nimiq Pay PIN or recovery phrase.
              </p>
            </details>
            <Notice text={error} />
            <p className="muted auth-access-note">
              Each organiser wallet has its own private campaigns and claim
              reviews. Contributors do not need an account.
            </p>
            <p className="auth-contributor-note">
              <strong>Here to claim a reward?</strong> Open Nimiq Pay → Mini
              Apps → Custom URL and paste your complete invitation link. You do
              not need to sign in here.
            </p>
          </section>
        ) : (
          <section
            className="panel auth"
            id="organiser-access"
            aria-labelledby="organiser-access-title"
          >
            <p className="eyebrow">Private organiser access</p>
            <h1 id="organiser-access-title">Sign in to TESTNET</h1>
            <p>
              Create private invitations and review signed test claims. No
              payment will be made.
            </p>
            <form onSubmit={login} aria-busy={busy}>
              <label htmlFor="organiser-password">Workspace password</label>
              <div className="password-field">
                <input
                  id="organiser-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  aria-describedby="organiser-password-help"
                  required
                  maxLength={256}
                />
                <button
                  className="password-toggle"
                  type="button"
                  aria-controls="organiser-password"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
              <p className="auth-help" id="organiser-password-help">
                Use the separate TESTNET organiser password. This is not your
                Nimiq Pay PIN or recovery phrase.
              </p>
              <button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in to workspace"}
              </button>
            </form>
            <Notice text={error} />
            <p className="muted auth-access-note">
              This is a separate TESTNET organiser account. Contributors use
              their invitation links and never need this password.
            </p>
            <p className="auth-contributor-note">
              <strong>Here to claim a reward?</strong> In Nimiq Pay, open Mini
              Apps → Custom URL and paste the complete invitation link. You do
              not need to sign in here.
            </p>
          </section>
        )}
      </>
    );
  return (
    <>
      <div className="page-heading" id="organiser-access">
        <div>
          <p className="eyebrow">Organiser workspace</p>
          <h1>Your campaigns</h1>
          {claimsOnly && walletAddress && (
            <p className="muted">
              Signed in with Nimiq Pay · <code>{walletAddress}</code>
            </p>
          )}
        </div>
        <button
          className="quiet"
          onClick={async () => {
            try {
              await api("/logout", {});
              setAuthenticated(false);
              setWalletAddress(null);
              setSelected(undefined);
              setCreating(false);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Sign out
        </button>
      </div>
      <Notice text={error} />
      {selected ? (
        <CampaignDetail
          id={selected}
          back={() => {
            setSelected(undefined);
            load().catch((e) => setError(e.message));
          }}
        />
      ) : creating ? (
        <CreateCampaign
          staging={staging}
          claimsOnly={claimsOnly}
          cancel={() => setCreating(false)}
          created={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      ) : (
        <>
          <div className="toolbar">
            <p>
              {campaigns.length} campaign{campaigns.length === 1 ? "" : "s"}
            </p>
            <button onClick={() => setCreating(true)}>
              ＋ Create campaign
            </button>
          </div>
          {campaigns.length === 0 ? (
            <section className="panel empty">
              <span className="empty-symbol" aria-hidden="true">
                ↗
              </span>
              <h2>
                {staging
                  ? "Test the claim workflow."
                  : "A reward for a contribution."}
              </h2>
              <p>
                Create your first campaign, then share a unique invitation with
                each contributor.
              </p>
              <button onClick={() => setCreating(true)}>
                Create your first campaign
              </button>
            </section>
          ) : (
            <div className="campaign-grid">
              {campaigns.map((c) => (
                <button
                  className="campaign-card"
                  key={c.id}
                  onClick={() => setSelected(c.id)}
                >
                  <span className="eyebrow">
                    {c.expires <= Date.now() ? "Expired" : "Open for claims"}
                  </span>
                  <h2>{c.title}</h2>
                  <p>{c.description}</p>
                  <div className="amount">
                    {nim(c.amount)}{" "}
                    <small>
                      {staging
                        ? "NIM · illustrative TESTNET amount"
                        : claimsOnly
                          ? "NIM · unpaid commitment"
                          : "NIM / reward"}
                    </small>
                  </div>
                  <div className="card-meta">
                    <span>
                      {c.issued} / {c.slots} invitations
                    </span>
                    <span>{c.claimed} claims →</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
function CreateCampaign({
  staging,
  claimsOnly,
  cancel,
  created,
}: {
  staging?: boolean;
  claimsOnly?: boolean;
  cancel: () => void;
  created: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const r = await api("/campaigns", {
        title: f.get("title"),
        description: f.get("description"),
        amount: f.get("amount"),
        slots: Number(f.get("slots")),
        expires: new Date(String(f.get("expires"))).getTime(),
      });
      created(r.campaign.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <button className="text-button" onClick={cancel}>
        ← All campaigns
      </button>
      <h2>
        {staging
          ? "Create a TESTNET testing campaign"
          : claimsOnly
            ? "Create a reward-claim campaign"
            : "Create a reward campaign"}
      </h2>
      <p>
        {staging
          ? "Each invitation uses one claim-testing slot. Campaign details are fixed once created."
          : claimsOnly
            ? "Each invitation uses one claim slot. The declared reward amount is an unpaid commitment only; no NIM is held or sent."
            : "Each invitation reserves one reward slot. Campaign details are fixed once created."}
      </p>
      <form onSubmit={submit}>
        <label>
          Title
          <input
            name="title"
            required
            maxLength={100}
            placeholder="Community contributions"
          />
        </label>
        <label>
          Description
          <textarea
            name="description"
            required
            maxLength={2000}
            rows={3}
            placeholder={
              staging
                ? "What are you testing, and who should participate?"
                : "What are you rewarding, and who is eligible?"
            }
          />
        </label>
        <div className="form-row">
          <label>
            {staging
              ? "Illustrative TESTNET amount (NIM)"
              : claimsOnly
                ? "Reward commitment (NIM)"
                : "Reward amount (NIM)"}
            <input
              name="amount"
              type="number"
              min="0.00001"
              max="99999999.99999"
              step="0.00001"
              required
              inputMode="decimal"
            />
          </label>
          <label>
            {staging
              ? "Available testing slots"
              : claimsOnly
                ? "Available claim slots"
                : "Available rewards"}
            <input
              name="slots"
              type="number"
              min="1"
              max="1000"
              step="1"
              required
              inputMode="numeric"
            />
          </label>
        </div>
        <label>
          Expiry date and time (your local time)
          <input name="expires" type="datetime-local" required />
        </label>
        <p className="muted">
          {staging
            ? "TESTNET testing only. This amount is illustrative and non-redeemable. No NIM is held, owed, reserved, transferred or paid. Approval records an organiser review decision only."
            : claimsOnly
              ? "This is a declared reward commitment only. NimClaim does not hold, send or verify NIM payouts."
              : "No funds are held or sent. The amount is a reward commitment for organiser review."}
        </p>
        <Notice text={error} />
        <button disabled={busy}>
          {busy ? "Creating…" : "Create campaign"}
        </button>
      </form>
    </section>
  );
}
function CampaignDetail({ id, back }: { id: string; back: () => void }) {
  const [data, setData] = useState<{
    campaign: Campaign;
    wallet: { address: string } | null;
    paymentGate: PaymentGate;
    staging?: boolean;
    claimsOnly?: boolean;
    invitations: { id: string; created: number }[];
    claims: Claim[];
  }>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false);
  const load = useCallback(
    async () => setData(await api(`/campaigns/${id}`)),
    [id],
  );
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) load().catch((e) => setError(e.message));
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function invite() {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const r = await api(`/campaigns/${id}/invitations`, {});
      setLink(r.url);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decide(claim: Claim, decision: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/claims/${claim.id}/decision`, { decision });
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        <button className="text-button" onClick={back}>
          ← All campaigns
        </button>
        <Notice text={error} />
        <p role="status">Loading campaign…</p>
      </>
    );
  const c = data.campaign,
    expired = c.expires <= Date.now();
  return (
    <>
      <button className="text-button" onClick={back}>
        ← All campaigns
      </button>
      <section className="panel campaign-summary">
        <p className="eyebrow">
          {data.staging
            ? expired
              ? "Expired TESTNET testing campaign"
              : "TESTNET testing campaign"
            : data.claimsOnly
              ? expired
                ? "Expired MAINNET claims campaign"
                : "MAINNET claims campaign"
              : expired
                ? "Expired campaign"
                : "Reward campaign"}
        </p>
        <h2>{c.title}</h2>
        <p className="description">{c.description}</p>
        <div className="stats">
          <div>
            <strong>
              {nim(c.amount)} <small>NIM</small>
            </strong>
            <span>
              {data.staging
                ? "Illustrative TESTNET amount"
                : data.claimsOnly
                  ? "per contributor · unpaid commitment"
                  : "per contributor"}
            </span>
          </div>
          <div>
            <strong>
              {data.invitations.length} / {c.slots}
            </strong>
            <span>invitations issued</span>
          </div>
          <div>
            <strong>{data.claims.length}</strong>
            <span>claims received</span>
          </div>
        </div>
        <p className="muted">Expires {date(c.expires)}</p>
      </section>
      {!data.staging && (
        <CampaignWallet
          campaignId={id}
          wallet={data.wallet}
          gate={data.paymentGate}
          claimsOnly={data.claimsOnly}
          reload={load}
        />
      )}
      <section className="panel">
        <h2>Invite a contributor</h2>
        <p>
          {data.staging
            ? "Invitations are for claim-workflow testing only. One link uses one testing slot. Share it directly with the intended tester. No payment will be made."
            : data.claimsOnly
              ? "One link, one claim slot. Anyone with the link can submit a claim, so share it only with the intended recipient. NimClaim does not send NIM."
              : "One link, one reward slot. Anyone with the link can request the reward. Share it directly with the intended recipient."}
        </p>
        <button
          disabled={
            busy || expired || data.invitations.length >= c.slots || !!link
          }
          onClick={invite}
        >
          {expired
            ? "Campaign expired"
            : data.invitations.length >= c.slots
              ? "All invitations issued"
              : "Create unique invitation"}
        </button>
        {link && (
          <div className="link-box">
            <label>
              Save this invitation now. It cannot be retrieved later.
              <textarea
                rows={3}
                readOnly
                value={link}
                onFocus={(e) => e.target.select()}
              />
            </label>
            <div className="actions">
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  } catch {
                    setError(
                      "Clipboard unavailable. Select and copy the invitation manually.",
                    );
                  }
                }}
              >
                {copied ? "Copied" : "Copy invitation"}
              </button>
              <button
                className="text-button"
                onClick={() => {
                  setLink("");
                  setCopied(false);
                }}
              >
                I have saved this link
              </button>
            </div>
          </div>
        )}
      </section>
      <Notice text={error} />
      <div className="toolbar">
        <h2>Claims & history</h2>
        <button
          className="quiet"
          onClick={() => load().catch((e) => setError(e.message))}
        >
          Refresh
        </button>
      </div>
      <p className="muted">
        Refreshes every 15 seconds while visible. Each wallet can claim once per
        campaign.
      </p>
      {data.claims.length === 0 ? (
        <section className="panel empty">
          <h3>No claims yet</h3>
          <p>Signed claims will appear here for your review.</p>
        </section>
      ) : (
        data.claims.map((claim) => (
          <section className="panel claim-card" key={claim.id}>
            <Badge
              status={claimStatus(claim)}
              staging={data.staging}
              claimsOnly={data.claimsOnly}
            />
            <h3>Verified recipient</h3>
            <code className="address">{claim.address}</code>
            <History
              claim={claim}
              staging={data.staging}
              claimsOnly={data.claimsOnly}
            />
            {claim.status === "pending" && (
              <div className="actions">
                <button
                  disabled={busy || expired}
                  onClick={() => decide(claim, "payment-ready")}
                >
                  {data.staging || data.claimsOnly
                    ? "Approve claim"
                    : "Approve for payment"}
                </button>
                <button
                  className="secondary"
                  disabled={busy || expired}
                  onClick={() => decide(claim, "rejected")}
                >
                  Reject claim
                </button>
              </div>
            )}
            {claim.status === "payment-ready" && !claim.payment && (
              <p className="muted">
                {data.staging ? (
                  "Approved for testing — no payment will be made"
                ) : data.claimsOnly ? (
                  <>
                    Approved for {nim(c.amount)} NIM. NimClaim cannot send or
                    verify payment.
                  </>
                ) : (
                  <>
                    Approved for {nim(c.amount)} NIM. Approval alone does not
                    prove payment.
                  </>
                )}
              </p>
            )}
            {claim.status === "payment-ready" &&
              !data.staging &&
              !data.claimsOnly && <Payout claim={claim} reload={load} />}
          </section>
        ))
      )}
    </>
  );
}
function Recipient({ token, config }: { token: string; config: Config }) {
  const [data, setData] = useState<{
    campaign: Campaign;
    expired: boolean;
    claim: Claim | null;
  }>();
  const [wallet, setWallet] =
    useState<Awaited<ReturnType<typeof connectWallet>>>();
  const [challenge, setChallenge] = useState<{
    id: string;
    message: string;
    expires: number;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(
    async () => setData(await api("/invitation", { token })),
    [token],
  );
  useEffect(() => {
    setData(undefined);
    setChallenge(undefined);
    setWallet(undefined);
    setError("");
    load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden) load().catch((e) => setError(e.message));
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!wallet) return;

    const provider = wallet.provider;
    const connectedWalletAddress = wallet.walletAddress;

    return watchWalletAccounts(provider, (next) => {
      if (!next) {
        setWallet(undefined);
        setChallenge(undefined);
        setError(
          "Nimiq Pay no longer exposes an approved wallet. Reconnect before claiming.",
        );
        return;
      }

      setWallet((current) =>
        current?.provider === provider ? { ...current, ...next } : current,
      );

      // HTLC rotation is normal. Only a primary wallet change invalidates
      // the signing request.
      if (next.walletAddress !== connectedWalletAddress) {
        setChallenge(undefined);
        setError(
          "The Nimiq Pay wallet address changed. Reconnect before claiming.",
        );
      }
    });
  }, [wallet?.provider, wallet?.walletAddress]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      setChallenge(undefined);
      const connected = await connectWallet(config.network);
      setWallet(connected);
      setChallenge(await api("/challenge", { token }));
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(false);
    }
  }
  async function claim() {
    if (!wallet || !challenge) return;
    setBusy(true);
    setError("");
    try {
      const signed = await signChallenge(
        wallet.provider,
        challenge.message,
        config.network,
        wallet.walletAddress,
      );
      await api("/claim", {
        token,
        challengeId: challenge.id,
        publicKey: signed.publicKey,
        signature: signed.signature,
      });
      setChallenge(undefined);
      await load();
    } catch (e) {
      setError(walletError(e));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section className="panel">
        <h1>
          {config.staging
            ? "Your TESTNET testing invitation"
            : "Your reward invitation"}
        </h1>
        <Notice text={error} />
        {!error && <p role="status">Loading invitation…</p>}
        <button
          className="quiet"
          onClick={() => {
            setError("");
            load().catch((e) => setError(e.message));
          }}
        >
          Retry
        </button>
      </section>
    );
  const c = data.campaign;
  return (
    <div className="recipient">
      <p className="eyebrow">Contributor invitation</p>
      <h1>{c.title}</h1>
      <p className="description">{c.description}</p>
      <section className="panel reward">
        <span>
          {config.staging
            ? "Illustrative TESTNET amount"
            : "Your reward commitment"}
        </span>
        <div className="reward-amount">
          {nim(c.amount)} <small>NIM</small>
        </div>
        <p>
          {config.staging
            ? "TESTNET claim-workflow testing only. This amount is illustrative and non-redeemable. Signing verifies wallet ownership only. Approval records an organiser review decision and does not trigger a payment."
            : data.claim?.payment
              ? "Payment details and independently verified outcomes are shown below. No funds are held in escrow."
              : "Subject to organiser approval. Funds have not been reserved or sent."}
        </p>
        <p className="muted">
          Expires {date(c.expires)} · {config.network}
        </p>
      </section>
      {!config.claimsOnly && (
        <details>
          <summary>Read-only wallet diagnostics</summary>
          <WalletDiagnostics expectedNetwork={config.network} />
        </details>
      )}
      <Notice text={error} />
      {data.claim ? (
        <section className="panel">
          <Badge
            status={claimStatus(data.claim)}
            staging={config.staging}
            claimsOnly={config.claimsOnly}
          />
          <h2>
            {config.staging && data.claim.status === "payment-ready"
              ? "Approved for testing — no payment will be made"
              : claimStatus(data.claim) === "paid"
                ? "Your reward is paid."
                : claimStatus(data.claim) === "failed"
                  ? "Payment failed. Reward unpaid."
                  : data.claim.payment
                    ? "Payment verification is pending."
                    : data.claim.status === "payment-ready"
                      ? config.claimsOnly
                        ? "Approved · unpaid"
                        : "Approved. Awaiting payment."
                      : data.claim.status === "pending"
                        ? "Your request is with the organiser."
                        : "Your claim is closed."}
          </h2>
          <p>Wallet ownership verified for:</p>
          <code className="address">{data.claim.address}</code>
          <History
            claim={data.claim}
            staging={config.staging}
            claimsOnly={config.claimsOnly}
          />
          {!data.claim.payment && (
            <p>No NIM has been transferred through NimClaim.</p>
          )}
          <PaymentStatus payment={data.claim.payment} />
        </section>
      ) : data.expired ? (
        <section className="panel">
          <h2>This invitation has expired.</h2>
          <p>
            {config.staging
              ? "Contact your organiser about future testing."
              : "Contact your organiser about future rewards."}
          </p>
        </section>
      ) : (
        <section className="panel">
          <p className="eyebrow">Wallet ownership</p>
          <h2>Claim with Nimiq Pay</h2>
          <p>
            Connect your wallet, then sign a one-time request. Nimiq Pay chooses
            the signing account. The server verifies its signature before saving
            your claim.
          </p>
          {wallet && (
            <p className="wallet-status" role="status">
              Nimiq Pay connected · {wallet.network}
              <br />
              Consensus:{" "}
              {wallet.consensus === null
                ? "unavailable"
                : wallet.consensus
                  ? "established"
                  : "syncing"}{" "}
              · Block: {wallet.height ?? "unavailable"}
            </p>
          )}
          <button
            className={challenge ? "secondary" : ""}
            disabled={busy}
            onClick={connect}
          >
            {busy && !challenge
              ? "Connecting…"
              : challenge
                ? "Refresh signing request"
                : "Connect Nimiq Pay"}
          </button>
          {challenge && (
            <>
              <p>
                {config.claimsOnly ? (
                  <>
                    This signature verifies wallet ownership and submits your
                    claim for organiser review on MAINNET. It does not request
                    or authorise a NIM transfer.
                  </>
                ) : config.staging ? (
                  <>
                    This signature verifies wallet ownership for claim-workflow
                    testing on {config.network}. It does not request or
                    authorize a payment.
                  </>
                ) : (
                  <>
                    This signature requests {nim(c.amount)} NIM from this
                    campaign on {config.network}.
                  </>
                )}{" "}
                It expires at {date(challenge.expires)}.
              </p>
              <details>
                <summary>Review exact message</summary>
                <pre>{challenge.message}</pre>
              </details>
              <button disabled={busy} onClick={claim}>
                {busy ? "Waiting for wallet…" : "Sign & submit claim"}
              </button>
            </>
          )}
          <p className="muted">
            Your invitation is a secret access link. Its holder can view this
            claim and its verified wallet address. Signing does not send a
            transaction.
          </p>
        </section>
      )}
      <button
        className="quiet"
        disabled={busy}
        onClick={() => load().catch((e) => setError(e.message))}
      >
        Refresh claim status
      </button>
    </div>
  );
}
