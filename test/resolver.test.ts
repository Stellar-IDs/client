import { describe, expect, it } from "vitest";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { DidCache, DidReader, Signer } from "../src/index.js";
import {
  DidArchivedError,
  DidNotFoundError,
  DidParseError,
  InMemoryDidCache,
  NetworkError,
  SimulationError,
  createDidReader,
  didCacheKey,
  publicConfig,
  resolveIdentity,
  resolveRpcUrls,
  restoreIdentity,
  testnetConfig,
} from "../src/index.js";
import type { DidRecord } from "../src/generated/index.js";

const ADDRESS = "GA2DO5BZPTPE4OPB46XXZF37VGIJXG7D535QU4GWYJLZYISSXOZKKF4M";
const DID = `did:stellar:testnet:${ADDRESS}`;

function liveRecord(version = 3): DidRecord {
  return {
    controller: ADDRESS,
    verification_methods: [],
    authentication: [],
    assertion_method: [],
    services: [],
    created: 10n,
    updated: 20n,
    version,
    deactivated: false,
  };
}

function fakeSigner(): Signer {
  return {
    async publicKey() {
      return ADDRESS;
    },
    async signTransaction() {
      return "SIGNED_XDR";
    },
  };
}

describe("NetworkConfig multi-RPC support", () => {
  it("stays backward compatible with a single rpcUrl", () => {
    const cfg = testnetConfig({ rpcUrl: "https://rpc-1.example.test" });
    expect(cfg.rpcUrl).toBe("https://rpc-1.example.test");
    expect(resolveRpcUrls(cfg)).toEqual(["https://rpc-1.example.test"]);

    const pub = publicConfig(cfg.contractId, "https://pub-1.example.test");
    expect(resolveRpcUrls(pub)).toEqual(["https://pub-1.example.test"]);
  });

  it("preserves failover order and deduplicates rpcUrls", () => {
    const cfg = testnetConfig({
      rpcUrls: [
        "https://rpc-primary.example.test",
        "https://rpc-secondary.example.test",
        "https://rpc-primary.example.test",
      ],
    });
    expect(cfg.rpcUrl).toBe("https://rpc-primary.example.test");
    expect(resolveRpcUrls(cfg)).toEqual([
      "https://rpc-primary.example.test",
      "https://rpc-secondary.example.test",
    ]);

    const pub = publicConfig(cfg.contractId, [
      "https://pub-a.example.test",
      "https://pub-b.example.test",
    ]);
    expect(pub.rpcUrl).toBe("https://pub-a.example.test");
    expect(resolveRpcUrls(pub)).toEqual([
      "https://pub-a.example.test",
      "https://pub-b.example.test",
    ]);
  });

  it("throws NetworkError when no non-empty RPC endpoint is configured", () => {
    expect(() =>
      publicConfig("CB2ZHW3TBCVXQ22CLWUTIOJVCIS4CLGFX4WHLZQ663XSGKVYKFUBLZAT", ""),
    ).toThrow(NetworkError);
    expect(() =>
      publicConfig("CB2ZHW3TBCVXQ22CLWUTIOJVCIS4CLGFX4WHLZQ663XSGKVYKFUBLZAT", ["  "]),
    ).toThrow(NetworkError);
    expect(() =>
      resolveRpcUrls({
        ...testnetConfig(),
        rpcUrl: "   ",
        rpcUrls: [],
      }),
    ).toThrow(NetworkError);
  });
});

describe("createDidReader multi-RPC failover and archived detection", () => {
  it("fails over across rpcUrls in order on NetworkError and returns first healthy response", async () => {
    const attempted: string[] = [];
    const network = testnetConfig({
      rpcUrls: [
        "https://rpc-1.example.test",
        "https://rpc-2.example.test",
        "https://rpc-3.example.test",
      ],
    });
    const reader = createDidReader(network, {
      async transport(rpcUrl, address) {
        attempted.push(rpcUrl);
        expect(address).toBe(ADDRESS);
        if (rpcUrl === "https://rpc-1.example.test") {
          throw new TypeError("fetch failed");
        }
        if (rpcUrl === "https://rpc-2.example.test") {
          throw new NetworkError("503 Service Unavailable");
        }
        return liveRecord(7);
      },
    });

    const record = await reader.resolve(ADDRESS);
    expect(record.version).toBe(7);
    expect(attempted).toEqual([
      "https://rpc-1.example.test",
      "https://rpc-2.example.test",
      "https://rpc-3.example.test",
    ]);
  });

  it("throws NetworkError when all configured RPC endpoints are down", async () => {
    const attempted: string[] = [];
    const network = testnetConfig({
      rpcUrls: ["https://rpc-a.example.test", "https://rpc-b.example.test"],
    });
    const reader = createDidReader(network, {
      async transport(rpcUrl) {
        attempted.push(rpcUrl);
        throw new NetworkError(`${rpcUrl} unreachable`);
      },
    });

    await expect(reader.resolve(ADDRESS)).rejects.toThrow(/all 2 RPC endpoints failed/);
    expect(attempted).toEqual(["https://rpc-a.example.test", "https://rpc-b.example.test"]);
  });

  it("does not fail over on authoritative contract errors (DidNotFoundError, DidArchivedError)", async () => {
    const network = testnetConfig({
      rpcUrls: ["https://rpc-a.example.test", "https://rpc-b.example.test"],
    });
    const callsNotFound: string[] = [];
    const notFoundReader = createDidReader(network, {
      async transport(rpcUrl) {
        callsNotFound.push(rpcUrl);
        throw new Error("HostError: Error(Contract, #1)");
      },
    });
    await expect(notFoundReader.resolve(ADDRESS)).rejects.toThrow(DidNotFoundError);
    expect(callsNotFound).toEqual(["https://rpc-a.example.test"]);

    const callsArchived: string[] = [];
    const archivedReader = createDidReader(network, {
      async transport(rpcUrl) {
        callsArchived.push(rpcUrl);
        throw new AssembledTransaction.Errors.ExpiredState(
          "You need to restore some contract state before you can invoke this method.",
        );
      },
    });
    await expect(archivedReader.resolve(ADDRESS)).rejects.toThrow(DidArchivedError);
    expect(callsArchived).toEqual(["https://rpc-a.example.test"]);
  });
});

describe("InMemoryDidCache and resolver caching", () => {
  it("returns cache hits before TTL expiry and re-fetches on miss or after TTL expiry", async () => {
    let clock = 1_000;
    const cache = new InMemoryDidCache({
      defaultTtlMs: 5_000,
      maxEntries: 2,
      now: () => clock,
    });
    let rpcCalls = 0;
    const network = testnetConfig();
    const reader = createDidReader(network, {
      cache,
      cacheTtlMs: 5_000,
      async transport() {
        rpcCalls += 1;
        return liveRecord(rpcCalls);
      },
    });

    const first = await resolveIdentity(DID, { network, reader });
    expect(first.didDocumentMetadata?.versionId).toBe(1);
    expect(rpcCalls).toBe(1);

    // Cache hit within TTL window
    clock = 4_999;
    const second = await resolveIdentity(DID, { network, reader });
    expect(second.didDocumentMetadata?.versionId).toBe(1);
    expect(rpcCalls).toBe(1);

    // Cache miss once TTL elapses
    clock = 6_000;
    const third = await resolveIdentity(DID, { network, reader });
    expect(third.didDocumentMetadata?.versionId).toBe(2);
    expect(rpcCalls).toBe(2);
  });

  it("enforces maxEntries eviction and supports custom DidCache implementations", async () => {
    const cache = new InMemoryDidCache({ maxEntries: 2, defaultTtlMs: 10_000 });
    cache.set("k1", liveRecord(1));
    cache.set("k2", liveRecord(2));
    cache.set("k3", liveRecord(3));
    expect(cache.size).toBe(2);
    expect(cache.get("k1")).toBeUndefined();
    expect(cache.get("k2")?.version).toBe(2);
    expect(cache.get("k3")?.version).toBe(3);

    // Zero TTL disables caching and removes existing entry
    cache.set("k2", liveRecord(9), 0);
    expect(cache.get("k2")).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);

    // Custom async DidCache passed directly to resolveIdentity with injected reader
    const backing = new Map<string, DidRecord>();
    const customCache: DidCache = {
      async get(key) {
        return backing.get(key);
      },
      async set(key, value) {
        backing.set(key, value);
      },
    };
    let readerCalls = 0;
    const reader: DidReader = {
      async resolve() {
        readerCalls += 1;
        return liveRecord(11);
      },
    };
    const r1 = await resolveIdentity(DID, { reader, cache: customCache });
    const r2 = await resolveIdentity(DID, { reader, cache: customCache });
    expect(r1.didDocumentMetadata?.versionId).toBe(11);
    expect(r2.didDocumentMetadata?.versionId).toBe(11);
    expect(readerCalls).toBe(1);
  });
});

describe("resolveIdentity", () => {
  it("resolves a live DID to a document", async () => {
    const reader: DidReader = {
      async resolve(address: string) {
        expect(address).toBe(ADDRESS);
        return liveRecord();
      },
    };
    const res = await resolveIdentity(DID, { reader });
    expect(res.didDocument?.id).toBe(DID);
    expect(res.didResolutionMetadata.error).toBeUndefined();
    expect(res.didDocumentMetadata).toMatchObject({ versionId: 3 });
  });

  it("maps missing DIDs to DidNotFoundError", async () => {
    const reader: DidReader = {
      async resolve() {
        throw new DidNotFoundError(DID);
      },
    };
    await expect(resolveIdentity(DID, { reader })).rejects.toThrow(DidNotFoundError);
  });

  it("surfaces archived DIDs as DidArchivedError", async () => {
    const reader: DidReader = {
      async resolve() {
        throw new AssembledTransaction.Errors.ExpiredState(
          "You need to restore some contract state before you can invoke this method.",
        );
      },
    };
    await expect(resolveIdentity(DID, { reader })).rejects.toThrow(DidArchivedError);
  });

  it("resolves deactivated DIDs to tombstones", async () => {
    const reader: DidReader = {
      async resolve() {
        return { ...liveRecord(), deactivated: true };
      },
    };
    const res = await resolveIdentity(DID, { reader });
    expect(res.didResolutionMetadata.error).toBe("deactivated");
    expect(res.didDocument?.verificationMethod).toEqual([]);
    expect(res.didDocumentMetadata?.deactivated).toBe(true);
  });

  it("rejects malformed DIDs before any IO", async () => {
    const reader: DidReader = {
      async resolve(): Promise<DidRecord> {
        throw new Error("must not be called");
      },
    };
    await expect(resolveIdentity("did:stellar:testnet:bogus", { reader })).rejects.toThrow(
      DidParseError,
    );
  });

  it("surfaces transport failures as NetworkError", async () => {
    const reader: DidReader = {
      async resolve(): Promise<DidRecord> {
        throw new NetworkError("fetch failed");
      },
    };
    await expect(resolveIdentity(DID, { reader })).rejects.toThrow(NetworkError);
  });
});

describe("restoreIdentity", () => {
  it("restores an archived DID entry, fails over on NetworkError, and invalidates cache", async () => {
    const network = testnetConfig({
      rpcUrls: ["https://down.example.test", "https://healthy.example.test"],
    });
    const cache = new InMemoryDidCache();
    cache.set(didCacheKey(network, ADDRESS), liveRecord(1));

    const tried: string[] = [];
    const res = await restoreIdentity(DID, {
      signer: fakeSigner(),
      network,
      cache,
      async executor(rpcUrl, address) {
        tried.push(rpcUrl);
        expect(address).toBe(ADDRESS);
        if (rpcUrl === "https://down.example.test") {
          throw new NetworkError("endpoint down");
        }
        return { restored: true, txHash: "RESTORE_TX_123" };
      },
    });

    expect(res).toEqual({
      did: DID,
      restored: true,
      txHash: "RESTORE_TX_123",
    });
    expect(tried).toEqual(["https://down.example.test", "https://healthy.example.test"]);
    expect(cache.get(didCacheKey(network, ADDRESS))).toBeUndefined();
  });

  it("returns restored: false without invalidating cache when the entry is already live", async () => {
    const network = testnetConfig();
    const cache = new InMemoryDidCache();
    cache.set(didCacheKey(network, ADDRESS), liveRecord(4));

    const res = await restoreIdentity(DID, {
      signer: fakeSigner(),
      network,
      cache,
      async executor() {
        return { restored: false };
      },
    });
    expect(res).toEqual({ did: DID, restored: false });
    expect(cache.get(didCacheKey(network, ADDRESS))?.version).toBe(4);
  });

  it("rejects malformed DIDs, missing DIDs, and failed restorations with typed errors", async () => {
    await expect(
      restoreIdentity("did:stellar:testnet:invalid", { signer: fakeSigner() }),
    ).rejects.toThrow(DidParseError);

    await expect(
      restoreIdentity(DID, {
        signer: fakeSigner(),
        async executor() {
          throw new Error("HostError: Error(Contract, #1)");
        },
      }),
    ).rejects.toThrow(DidNotFoundError);

    await expect(
      restoreIdentity(DID, {
        signer: fakeSigner(),
        async executor() {
          throw new SimulationError("archived entry restoration failed with status FAILED");
        },
      }),
    ).rejects.toThrow(SimulationError);
  });
});
