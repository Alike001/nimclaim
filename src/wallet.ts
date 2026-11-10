import {
  init,
  getHostNetwork,
  NimiqProviderError,
  type NimiqProvider,
} from "@nimiq/mini-app-sdk";

export type WalletAccountState = {
  accounts: string[];
  walletAddress: string;
  htlcAddress: string | null;
};

function parseWalletAccounts(accounts: readonly string[]): WalletAccountState {
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !accounts[0].trim()
  ) {
    throw new Error("Nimiq Pay did not share a valid wallet address.");
  }

  return {
    accounts: [...accounts],
    walletAddress: accounts[0],
    htlcAddress: accounts[1] || null,
  };
}

export function watchWalletAccounts(
  provider: NimiqProvider,
  listener: (accounts: WalletAccountState | null) => void,
) {
  const handle = (accounts: string[]) => {
    try {
      listener(parseWalletAccounts(accounts));
    } catch {
      listener(null);
    }
  };

  provider.on("accountsChanged", handle);

  return () => {
    provider.removeListener("accountsChanged", handle);
  };
}

export function walletError(error: unknown): string {
  if (NimiqProviderError.is(error)) {
    const messages: Record<string, string> = {
      PERMISSION_DENIED:
        "Request cancelled in Nimiq Pay. You can try again when ready.",
      UNKNOWN_REQUEST:
        "This wallet version does not support the request. Update Nimiq Pay.",
      NETWORK_ERROR:
        "Nimiq Pay reported a network error. Check its connection before retrying.",
      INTERNAL_ERROR: "Nimiq Pay could not complete the request.",
    };

    return `${messages[error.type] ?? "Nimiq Pay could not complete the request."} (${error.type}${error.code === undefined ? "" : `, ${error.code}`})`;
  }

  return error instanceof Error ? error.message : "Wallet request failed.";
}

export async function connectWallet(network: string) {
  let provider: NimiqProvider;

  try {
    provider = await init({ timeout: 3000 });
  } catch {
    throw new Error(
      "Nimiq Pay is unavailable in this browser. Open this invitation inside Nimiq Pay, or update the app and retry.",
    );
  }

  const hostNetwork = getHostNetwork();

  if (!hostNetwork) {
    throw new Error(
      "Wallet network is unavailable. Update Nimiq Pay before claiming.",
    );
  }

  if (hostNetwork !== network) {
    throw new Error(
      `Network mismatch: this campaign uses ${network}; Nimiq Pay uses ${hostNetwork}. Switch networks before claiming.`,
    );
  }

  const accountState = parseWalletAccounts(await freshWalletAccounts(provider));

  // Status methods do not use normalized wallet errors and can fail independently.
  const [consensus, height] = await Promise.allSettled([
    provider.isConsensusEstablished(),
    provider.getBlockNumber(),
  ]);

  return {
    provider,
    ...accountState,
    network: hostNetwork,
    consensus: consensus.status === "fulfilled" ? consensus.value : null,
    height: height.status === "fulfilled" ? height.value : null,
  };
}

export async function signChallenge(
  provider: NimiqProvider,
  message: string,
  network: string,
  expectedWalletAddress: string,
) {
  if (getHostNetwork() !== network) {
    throw new Error("Wallet network changed. Reconnect before signing.");
  }

  let challenge: { network?: string; origin?: string };

  try {
    challenge = JSON.parse(message);
  } catch {
    throw new Error("Server signing challenge is invalid.");
  }

  if (challenge.network !== network || challenge.origin !== location.origin) {
    throw new Error(
      "Signing challenge network or origin does not match this page. Claim blocked.",
    );
  }

  let walletChanged = false;

  const handleAccountsChanged = (accounts: string[]) => {
    if (!Array.isArray(accounts) || accounts[0] !== expectedWalletAddress) {
      walletChanged = true;
    }
  };

  // Subscribe before reading accounts to close the account-change race.
  provider.on("accountsChanged", handleAccountsChanged);

  try {
    const before = parseWalletAccounts(await freshWalletAccounts(provider));

    if (walletChanged || before.walletAddress !== expectedWalletAddress) {
      throw new Error(
        "The Nimiq Pay wallet address changed. Reconnect before signing.",
      );
    }

    if (getHostNetwork() !== network) {
      throw new Error("Wallet network changed. Reconnect before signing.");
    }

    const signed = await provider.sign(message);

    // Verify again after the wallet interaction, not just before it.
    const after = parseWalletAccounts(await freshWalletAccounts(provider));

    if (walletChanged || after.walletAddress !== expectedWalletAddress) {
      throw new Error(
        "The Nimiq Pay wallet changed during signing. Reconnect before retrying.",
      );
    }

    if (getHostNetwork() !== network) {
      throw new Error("Wallet network changed during signing.");
    }

    return signed;
  } finally {
    provider.removeListener("accountsChanged", handleAccountsChanged);
  }
}

export interface PayoutAccounts {
  organiser: string;
  htlc: string;
}
// SDK 0.2.5 caches successful reads. Never fall back to a previous approval on
// rejection/error. disconnect() clears the provider cache, not backend sessions
// or host permissions; renewed access may require another approval dialog.
export async function freshWalletAccounts(provider: NimiqProvider) {
  provider.disconnect();
  const accounts = await provider.listAccounts();
  if (
    !Array.isArray(accounts) ||
    accounts.some((a) => typeof a !== "string" || !a)
  )
    throw new Error("Nimiq Pay returned invalid accounts. Payment blocked.");
  return accounts;
}

// Host-specific roles reviewed at nimiq/nimiq-pay-app revision
// dd90a9c5443be3f4e0ddeac454486c9d512fcae3, useMiniAppHost.ts:getNimiqAccounts.
// This ordering is NOT an SDK contract or proof of ownership. The campaign's
// signed organiser identity and independent server HTLC checks remain mandatory.
// Host bridge caches and changes after approval still require device validation.
export async function payoutAccounts(
  provider: NimiqProvider,
  expected?: PayoutAccounts,
) {
  const accounts = await freshWalletAccounts(provider);
  if (
    accounts.length !== 2 ||
    !accounts[0] ||
    !accounts[1] ||
    accounts[0] === accounts[1]
  )
    throw new Error(
      "Both the local organiser wallet and active remote HTLC are required. Payment blocked.",
    );
  const selected = { organiser: accounts[0], htlc: accounts[1] };
  if (
    expected &&
    (selected.organiser !== expected.organiser ||
      selected.htlc !== expected.htlc)
  )
    throw new Error(
      "Active wallet or HTLC changed. Payment blocked; reconcile any reservation.",
    );
  return selected;
}
