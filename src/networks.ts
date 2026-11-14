/**
 * Network configuration: how the SDK reaches the contract.
 *
 * Contract addresses and passphrases come from config, never from code
 * (PLAYBOOK §5.1.5). The default testnet contract ID is copied from
 * `stellar-id-core/deployments/testnet.json` at bindings-sync time and
 * embedded in the vendored `src/generated` module.
 */
import { networks as generatedNetworks } from "./generated/index.js";
import type { DidNetwork } from "./did.js";
import { NetworkError } from "./errors.js";

/** Everything the SDK needs to talk to one network. */
export interface NetworkConfig {
  /** The DID network segment (`testnet` or `public`). */
  network: DidNetwork;
  /** Stellar network passphrase used for signing. */
  networkPassphrase: string;
  /** Primary Soroban RPC endpoint (kept for backward compatibility). */
  rpcUrl: string;
  /**
   * Optional ordered list of Soroban RPC endpoints used for failover.
   * When provided and non-empty, readers try these endpoints in order on
   * {@link NetworkError}. When omitted, `[rpcUrl]` is used.
   */
  rpcUrls?: readonly string[];
  /** Deployed `stellar-id-core` contract ID (`C...`). */
  contractId: string;
}

/** Default Soroban RPC endpoint for Stellar testnet. */
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * Normalize a {@link NetworkConfig}'s RPC endpoints into an ordered,
 * deduplicated, non-empty list.
 *
 * When `network.rpcUrls` is present and contains at least one non-blank URL,
 * those URLs take precedence in order (with `network.rpcUrl` appended if not
 * already listed and non-blank). Otherwise `[network.rpcUrl]` is returned.
 *
 * @param network - Network configuration to inspect.
 * @returns Ordered list of unique RPC endpoint URLs.
 * @throws {NetworkError} When no non-empty RPC endpoint is configured.
 */
export function resolveRpcUrls(network: NetworkConfig): string[] {
  const candidates =
    network.rpcUrls !== undefined && network.rpcUrls.length > 0
      ? [...network.rpcUrls]
      : [network.rpcUrl];

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }

  if (ordered.length === 0) {
    throw new NetworkError("no Soroban RPC endpoint URL configured");
  }
  return ordered;
}

/**
 * Network configuration for Stellar testnet.
 *
 * @param overrides - Optional `rpcUrl`, `rpcUrls`, and/or `contractId`
 * overrides (e.g. multi-RPC failover or after a testnet reset + redeploy).
 * @returns The testnet configuration.
 */
export function testnetConfig(
  overrides?: Partial<Pick<NetworkConfig, "rpcUrl" | "rpcUrls" | "contractId">>,
): NetworkConfig {
  const customUrls = overrides?.rpcUrls?.map((u) => u.trim()).filter((u) => u.length > 0);
  const primaryUrl =
    overrides?.rpcUrl ??
    (customUrls !== undefined && customUrls.length > 0 ? customUrls[0] : undefined) ??
    TESTNET_RPC_URL;
  return {
    network: "testnet",
    networkPassphrase: generatedNetworks.testnet.networkPassphrase,
    rpcUrl: primaryUrl,
    ...(overrides?.rpcUrls === undefined ? {} : { rpcUrls: overrides.rpcUrls }),
    contractId: overrides?.contractId ?? generatedNetworks.testnet.contractId,
  };
}

/**
 * Network configuration for Stellar public network (mainnet).
 *
 * There is intentionally no default contract ID: v1 is testnet-only and
 * mainnet deployment is an explicit non-goal, so callers must supply the
 * contract they mean.
 *
 * @param contractId - The deployed contract ID on the public network.
 * @param rpcUrl - A single Soroban RPC URL or an ordered list of failover URLs.
 * @returns The public-network configuration.
 * @throws {NetworkError} When `rpcUrl` is an empty list or blank string.
 */
export function publicConfig(
  contractId: string,
  rpcUrl: string | readonly string[],
): NetworkConfig {
  if (typeof rpcUrl === "string") {
    const trimmed = rpcUrl.trim();
    if (trimmed.length === 0) {
      throw new NetworkError("no Soroban RPC endpoint URL configured");
    }
    return {
      network: "public",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      rpcUrl: trimmed,
      contractId,
    };
  }
  const urls = rpcUrl.map((u) => u.trim()).filter((u) => u.length > 0);
  const first = urls[0];
  if (first === undefined) {
    throw new NetworkError("no Soroban RPC endpoint URL configured");
  }
  return {
    network: "public",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: first,
    rpcUrls: urls,
    contractId,
  };
}
