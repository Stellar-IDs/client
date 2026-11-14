/**
 * DID resolution: read-only lookup of a DID via RPC simulation (free, no
 * signing), multi-RPC failover, optional TTL-bounded caching, archived-entry
 * detection + restoration, and mapping to the DID Resolution shape.
 */
import { rpc } from "@stellar/stellar-sdk";
import type { DidRecord } from "./generated/index.js";
import { parseDid } from "./did.js";
import { DidArchivedError, NetworkError, SimulationError, StellarIdError } from "./errors.js";
import { adaptSigner, buildClient, mapCallError, unwrapResult, withTimeout } from "./gateway.js";
import type { SubmitOptions } from "./gateway.js";
import type { NetworkConfig } from "./networks.js";
import { resolveRpcUrls, testnetConfig } from "./networks.js";
import type { Signer } from "./signers.js";
import { toW3CDocument } from "./w3c.js";
import type { DidDocument } from "./w3c.js";

/** Default cache entry lifetime in milliseconds (30 seconds). */
export const DEFAULT_RESOLVER_CACHE_TTL_MS = 30_000;

/** Injected contract reader (the default talks to RPC; tests inject fakes). */
export interface DidReader {
  /**
   * Read the on-chain record for an address.
   *
   * @param address - The controller `G...` address.
   * @returns The on-chain record.
   */
  resolve(address: string): Promise<DidRecord>;
}

/** Optional TTL-bounded cache interface for resolved DID records. */
export interface DidCache {
  /**
   * Look up a cached record by key.
   *
   * @param key - Scoped cache key (see {@link didCacheKey}).
   * @returns The cached record, or `undefined` on miss or expiry.
   */
  get(key: string): Promise<DidRecord | undefined> | DidRecord | undefined;
  /**
   * Store a resolved record with a bounded time-to-live.
   *
   * @param key - Scoped cache key.
   * @param record - On-chain DID record to cache.
   * @param ttlMs - Entry lifetime in milliseconds.
   */
  set(key: string, record: DidRecord, ttlMs: number): Promise<void> | void;
  /**
   * Remove a cached entry (for example after restoring or updating a DID).
   *
   * @param key - Scoped cache key.
   */
  delete?(key: string): Promise<void> | void;
}

/** Configuration options for {@link InMemoryDidCache}. */
export interface InMemoryDidCacheOptions {
  /** Default TTL in milliseconds when none is passed to `set` (default 30_000). */
  defaultTtlMs?: number;
  /** Maximum number of entries retained before evicting the oldest (default 500). */
  maxEntries?: number;
  /** Clock override returning current epoch milliseconds (for deterministic tests). */
  now?: () => number;
}

/**
 * Bounded in-memory {@link DidCache} implementation with lazy + insertion-time
 * TTL expiration and oldest-entry eviction.
 */
export class InMemoryDidCache implements DidCache {
  private readonly store = new Map<string, { record: DidRecord; expiresAt: number }>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  /**
   * Create an in-memory DID cache.
   *
   * @param opts - Optional TTL, capacity, and clock overrides.
   */
  constructor(opts?: InMemoryDidCacheOptions) {
    this.defaultTtlMs = opts?.defaultTtlMs ?? DEFAULT_RESOLVER_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, opts?.maxEntries ?? 500);
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Number of non-expired entries currently stored.
   *
   * @returns Active entry count.
   */
  get size(): number {
    this.pruneExpired();
    return this.store.size;
  }

  /**
   * Retrieve a cached {@link DidRecord} if present and not expired.
   *
   * @param key - Scoped cache key.
   * @returns The cached record, or `undefined` on miss/expiry.
   */
  get(key: string): DidRecord | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.record;
  }

  /**
   * Insert or update a cached {@link DidRecord} with a TTL in milliseconds.
   * Non-positive `ttlMs` deletes any existing entry instead of caching.
   *
   * @param key - Scoped cache key.
   * @param record - Resolved DID record.
   * @param ttlMs - Lifetime in milliseconds.
   */
  set(key: string, record: DidRecord, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    if (effectiveTtl <= 0) {
      this.store.delete(key);
      return;
    }
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      this.pruneExpired();
      if (this.store.size >= this.maxEntries) {
        const oldestKey = this.store.keys().next().value;
        if (oldestKey !== undefined) {
          this.store.delete(oldestKey);
        }
      }
    }
    this.store.set(key, {
      record,
      expiresAt: this.now() + effectiveTtl,
    });
  }

  /**
   * Delete a single cached entry.
   *
   * @param key - Scoped cache key.
   */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all cached entries. */
  clear(): void {
    this.store.clear();
  }

  private pruneExpired(): void {
    const current = this.now();
    for (const [k, v] of this.store) {
      if (current >= v.expiresAt) {
        this.store.delete(k);
      }
    }
  }
}

/**
 * Build the scoped cache key for a controller address on a specific network
 * and contract deployment.
 *
 * @param network - Network configuration.
 * @param address - Controller `G...` address.
 * @returns Scoped cache key string.
 */
export function didCacheKey(network: NetworkConfig, address: string): string {
  return `${network.network}:${network.contractId}:${address}`;
}

/** Per-endpoint RPC resolution transport (injectable for deterministic unit tests). */
export type RpcResolveTransport = (rpcUrl: string, address: string) => Promise<DidRecord>;

/** Options for {@link createDidReader}. */
export interface CreateDidReaderOptions {
  /** Optional TTL-bounded cache checked before calling RPC. */
  cache?: DidCache;
  /** Cache entry TTL in milliseconds (defaults to {@link DEFAULT_RESOLVER_CACHE_TTL_MS}). */
  cacheTtlMs?: number;
  /** Optional custom per-endpoint RPC transport for testing. */
  transport?: RpcResolveTransport;
}

/** Options for {@link resolveIdentity}. */
export interface ResolveOptions {
  /** Network to resolve on (defaults to testnet). */
  network?: NetworkConfig;
  /** Injected reader for tests; defaults to a live RPC reader with failover. */
  reader?: DidReader;
  /** Optional TTL-bounded cache for resolved DID records. */
  cache?: DidCache;
  /** Cache TTL in milliseconds (defaults to {@link DEFAULT_RESOLVER_CACHE_TTL_MS}). */
  cacheTtlMs?: number;
}

/** Metadata about the resolution process itself. */
export interface ResolutionMetadata {
  /** Always `application/did+ld+json` on success. */
  contentType: "application/did+ld+json";
  /** Machine-readable failure (`notFound`, `deactivated`), if any. */
  error?: "notFound" | "deactivated";
}

/** Metadata about the resolved document. */
export interface DocumentMetadata {
  /** Ledger creation timestamp (seconds). */
  created: number;
  /** Ledger last-update timestamp (seconds). */
  updated: number;
  /** On-chain version number. */
  versionId: number;
  /** Present and true for tombstones. */
  deactivated?: boolean;
  /** The backing Stellar account. */
  method: { stellarAccount: string };
}

/** DID Resolution result shape. */
export interface ResolutionResult {
  /** The input DID string. */
  did: string;
  /** The rendered JSON-LD document, or a tombstone when deactivated. */
  didDocument: DidDocument | null;
  /** Resolution process metadata. */
  didResolutionMetadata: ResolutionMetadata;
  /** Document metadata. */
  didDocumentMetadata: DocumentMetadata | null;
}

function defaultResolveTransport(network: NetworkConfig): RpcResolveTransport {
  return async (rpcUrl: string, address: string): Promise<DidRecord> => {
    const did = `did:stellar:${network.network}:${address}`;
    const client = buildClient(network, undefined, rpcUrl);
    const tx = await client.resolve({ controller: address });
    await tx.simulate();
    if (tx.simulation !== undefined && rpc.Api.isSimulationRestore(tx.simulation)) {
      throw new DidArchivedError(did);
    }
    return unwrapResult(tx.result, did);
  };
}

/**
 * Create an RPC-backed {@link DidReader} with ordered multi-RPC failover on
 * {@link NetworkError}, archived-entry detection ({@link DidArchivedError}),
 * and optional TTL-bounded caching.
 *
 * @param network - Network configuration (single `rpcUrl` or multiple `rpcUrls`).
 * @param opts - Optional cache and transport overrides.
 * @returns A reader that simulates `resolve` (no signing, no fee).
 * @throws {NetworkError} Immediately if `network` has no valid RPC URLs.
 */
export function createDidReader(network: NetworkConfig, opts?: CreateDidReaderOptions): DidReader {
  const urls = resolveRpcUrls(network);
  const transport = opts?.transport ?? defaultResolveTransport(network);
  const cache = opts?.cache;
  const cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_RESOLVER_CACHE_TTL_MS;

  return {
    async resolve(address: string): Promise<DidRecord> {
      const cacheKey = didCacheKey(network, address);
      if (cache !== undefined) {
        const hit = await cache.get(cacheKey);
        if (hit !== undefined) {
          return hit;
        }
      }

      const did = `did:stellar:${network.network}:${address}`;
      let lastNetworkError: NetworkError | undefined;
      let lastFailedUrl = urls[0] ?? network.rpcUrl;

      for (const rpcUrl of urls) {
        try {
          const record = await transport(rpcUrl, address);
          if (cache !== undefined && cacheTtlMs > 0) {
            await cache.set(cacheKey, record, cacheTtlMs);
          }
          return record;
        } catch (rawErr) {
          let mapped: unknown;
          try {
            if (rawErr instanceof StellarIdError) {
              mapped = rawErr;
            } else {
              mapCallError(rawErr, did);
            }
          } catch (typedErr) {
            mapped = typedErr;
          }

          if (mapped instanceof NetworkError) {
            lastNetworkError = mapped;
            lastFailedUrl = rpcUrl;
            continue;
          }
          throw mapped;
        }
      }

      if (urls.length === 1 && lastNetworkError !== undefined) {
        throw lastNetworkError;
      }
      throw new NetworkError(
        `all ${urls.length} RPC endpoints failed (last endpoint ${lastFailedUrl}: ${
          lastNetworkError?.message ?? "unknown transport error"
        })`,
        lastNetworkError,
      );
    },
  };
}

/**
 * Resolve a `did:stellar` identifier.
 *
 * Deactivated DIDs resolve to a tombstone document (empty keys/services)
 * with `deactivated` metadata — never to `notFound`.
 *
 * @param did - The DID string, e.g. `did:stellar:testnet:GABC...`.
 * @param opts - Network, optional cache, and optional injected reader.
 * @returns The resolution result.
 * @throws {DidParseError} If the DID string is malformed.
 * @throws {DidNotFoundError} If no on-chain record exists.
 * @throws {DidArchivedError} If the on-chain DID entry is archived and needs restoration.
 * @throws {NetworkError} On transport failures across all configured RPC endpoints.
 * @throws {SimulationError} On unexpected contract/RPC failures.
 */
export async function resolveIdentity(
  did: string,
  opts?: ResolveOptions,
): Promise<ResolutionResult> {
  const { address } = parseDid(did);
  const network = opts?.network ?? testnetConfig();
  const cache = opts?.cache;
  const cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_RESOLVER_CACHE_TTL_MS;
  const cacheKey = didCacheKey(network, address);

  let record: DidRecord | undefined;
  if (opts?.reader !== undefined && cache !== undefined) {
    record = await cache.get(cacheKey);
  }

  if (record === undefined) {
    const reader =
      opts?.reader ??
      createDidReader(network, {
        ...(cache === undefined ? {} : { cache }),
        cacheTtlMs,
      });
    try {
      record = await reader.resolve(address);
    } catch (err) {
      mapCallError(err, did);
    }
    if (opts?.reader !== undefined && cache !== undefined && cacheTtlMs > 0) {
      await cache.set(cacheKey, record, cacheTtlMs);
    }
  }

  const document = toW3CDocument(record, did);
  if (record.deactivated) {
    return {
      did,
      didDocument: document,
      didResolutionMetadata: { contentType: "application/did+ld+json", error: "deactivated" },
      didDocumentMetadata: {
        created: Number(record.created),
        updated: Number(record.updated),
        versionId: record.version,
        deactivated: true,
        method: { stellarAccount: address },
      },
    };
  }
  return {
    did,
    didDocument: document,
    didResolutionMetadata: { contentType: "application/did+ld+json" },
    didDocumentMetadata: {
      created: Number(record.created),
      updated: Number(record.updated),
      versionId: record.version,
      method: { stellarAccount: address },
    },
  };
}

/** Result of {@link restoreIdentity}. */
export interface RestoreIdentityResult {
  /** The canonical DID string inspected/restored. */
  did: string;
  /** `true` if an archived ledger entry was restored; `false` if already live. */
  restored: boolean;
  /** Restoration transaction hash when `restored` is `true`. */
  txHash?: string;
}

/** Per-endpoint restoration executor (injectable for deterministic unit tests). */
export type RestoreExecutor = (
  rpcUrl: string,
  address: string,
  signer: Signer,
  network: NetworkConfig,
) => Promise<{ restored: boolean; txHash?: string }>;

/** Options for {@link restoreIdentity}. */
export interface RestoreIdentityOptions {
  /** Funded signer paying the Soroban `RestoreFootprintOp` rent fee. */
  signer: Signer;
  /** Network configuration (defaults to testnet; supports `rpcUrls` failover). */
  network?: NetworkConfig;
  /** Optional resolver cache to invalidate once restoration succeeds. */
  cache?: DidCache;
  /** Timeout configuration for simulation and restoration submission. */
  submit?: Pick<SubmitOptions, "timeoutMs">;
  /** Optional custom per-endpoint executor for offline testing. */
  executor?: RestoreExecutor;
}

function defaultRestoreExecutor(timeoutMs: number): RestoreExecutor {
  return async (
    rpcUrl: string,
    address: string,
    signer: Signer,
    network: NetworkConfig,
  ): Promise<{ restored: boolean; txHash?: string }> => {
    const did = `did:stellar:${network.network}:${address}`;
    const signerAddress = await signer.publicKey();
    const client = buildClient(network, signerAddress, rpcUrl, adaptSigner(signer, network));
    const tx = await withTimeout(client.resolve({ controller: address }), timeoutMs, "simulation");
    await withTimeout(tx.simulate(), timeoutMs, "simulation");

    if (tx.simulation !== undefined && rpc.Api.isSimulationRestore(tx.simulation)) {
      const response = await withTimeout(
        tx.restoreFootprint(tx.simulation.restorePreamble),
        timeoutMs,
        "restoration",
      );
      if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new SimulationError(
          `archived entry restoration failed with status ${String(response.status)}`,
        );
      }
      return { restored: true, txHash: response.txHash };
    }

    // Verify the DID record exists when no restoration preamble was returned.
    unwrapResult(tx.result, did);
    return { restored: false };
  };
}

/**
 * Restore an archived on-chain DID entry using Soroban's `RestoreFootprintOp`
 * so subsequent {@link resolveIdentity} calls succeed.
 *
 * Any funded account may submit the restoration (no controller authorization
 * is required to restore rent). When the DID record is already live, no
 * transaction is submitted and `{ restored: false }` is returned.
 *
 * @param did - The `did:stellar:...` identifier whose ledger entry is archived.
 * @param opts - Funded signer, optional network (with failover), and optional cache.
 * @returns Whether restoration ran and the restoration transaction hash if so.
 * @throws {DidParseError} If `did` is malformed.
 * @throws {DidNotFoundError} If the DID has never been registered on-chain.
 * @throws {NetworkError} If all configured RPC endpoints fail with transport errors.
 * @throws {SimulationError} If simulation or footprint restoration fails.
 */
export async function restoreIdentity(
  did: string,
  opts: RestoreIdentityOptions,
): Promise<RestoreIdentityResult> {
  const { address } = parseDid(did);
  const network = opts.network ?? testnetConfig();
  const urls = resolveRpcUrls(network);
  const timeoutMs = opts.submit?.timeoutMs ?? 120_000;
  const executor = opts.executor ?? defaultRestoreExecutor(timeoutMs);

  let lastNetworkError: NetworkError | undefined;
  let lastFailedUrl = urls[0] ?? network.rpcUrl;

  for (const rpcUrl of urls) {
    try {
      const outcome = await executor(rpcUrl, address, opts.signer, network);
      if (outcome.restored && opts.cache?.delete !== undefined) {
        await opts.cache.delete(didCacheKey(network, address));
      }
      return {
        did,
        restored: outcome.restored,
        ...(outcome.txHash === undefined ? {} : { txHash: outcome.txHash }),
      };
    } catch (rawErr) {
      let mapped: unknown;
      try {
        if (rawErr instanceof StellarIdError) {
          mapped = rawErr;
        } else {
          mapCallError(rawErr, did);
        }
      } catch (typedErr) {
        mapped = typedErr;
      }

      if (mapped instanceof NetworkError) {
        lastNetworkError = mapped;
        lastFailedUrl = rpcUrl;
        continue;
      }
      throw mapped;
    }
  }

  if (urls.length === 1 && lastNetworkError !== undefined) {
    throw lastNetworkError;
  }
  throw new NetworkError(
    `all ${urls.length} RPC endpoints failed (last endpoint ${lastFailedUrl}: ${
      lastNetworkError?.message ?? "unknown transport error"
    })`,
    lastNetworkError,
  );
}
