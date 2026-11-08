import {
  init,
  getHostNetwork,
  NimiqProviderError,
  type NimiqProvider,
} from "@nimiq/mini-app-sdk";
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
  if (!hostNetwork)
    throw new Error(
      "Wallet network is unavailable. Update Nimiq Pay before claiming.",
    );
  if (hostNetwork !== network)
    throw new Error(
      `Network mismatch: this campaign uses ${network}; Nimiq Pay uses ${hostNetwork}. Switch networks before claiming.`,
    );
  const accounts = await provider.listAccounts();
  if (!accounts.length)
    throw new Error("Nimiq Pay did not share any accounts.");
  // Status methods do not use normalized wallet errors and can fail independently.
  const [consensus, height] = await Promise.allSettled([
    provider.isConsensusEstablished(),
    provider.getBlockNumber(),
  ]);
  return {
    provider,
    accounts,
    network: hostNetwork,
    consensus: consensus.status === "fulfilled" ? consensus.value : null,
    height: height.status === "fulfilled" ? height.value : null,
  };
}
export async function signChallenge(
  provider: NimiqProvider,
  message: string,
  network: string,
) {
  if (getHostNetwork() !== network)
    throw new Error("Wallet network changed. Reconnect before signing.");
  let challenge: { network?: string; origin?: string };
  try {
    challenge = JSON.parse(message);
  } catch {
    throw new Error("Server signing challenge is invalid.");
  }
  if (challenge.network !== network || challenge.origin !== location.origin)
    throw new Error(
      "Signing challenge network or origin does not match this page. Claim blocked.",
    );
  return provider.sign(message);
}
