// One package-wide resolution and connection owner {§http-security-boundary}.
// The SOCKS5 listener is deliberately small: RFC 1928 CONNECT with no auth,
// bound only to daemon loopback.

import type { LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import net, { type AddressInfo, type Socket } from "node:net";
import {
    Dispatcher1Wrapper,
    Socks5ProxyAgent,
    type Dispatcher,
} from "undici";
import {
    GuardBlockedError,
    GuardResolutionError,
    isPublicAddress,
    networkTarget,
    type GuardAdmission,
} from "./NetworkPolicy.ts";

const LOOPBACK = "127.0.0.1";
const CACHE_TTL_MS = 60_000;
const MAX_PENDING_BYTES = 64 * 1024;

const SOCKS = Object.freeze({
    version: 0x05,
    noAuth: 0x00,
    noAcceptableAuth: 0xff,
    connect: 0x01,
    ipv4: 0x01,
    domain: 0x03,
    ipv6: 0x04,
    success: 0x00,
    failure: 0x01,
    policyRefused: 0x02,
    resolutionFailed: 0x04,
    connectionRefused: 0x05,
    commandUnsupported: 0x07,
    addressUnsupported: 0x08,
});

export type BrokerLookup = (host: string) => Promise<ReadonlyArray<LookupAddress>>;

export interface BrokerTarget {
    readonly host: string;
    readonly port: number;
    readonly addresses: ReadonlyArray<LookupAddress>;
}

export type BrokerConnector = (target: BrokerTarget) => Promise<Socket>;

export interface AdmissionBoundary {
    admit(raw: string): Promise<GuardAdmission>;
    localProxyUrl(requireFixedPort?: boolean): Promise<string>;
    dispatcher(): Promise<Dispatcher>;
    legacyDispatcher(): Promise<Dispatcher>;
    translateTransportError(raw: string, cause: unknown): unknown;
}

export interface AdmissionLease extends AdmissionBoundary {
    close(): Promise<void>;
}

export interface AdmissionBrokerOwner {
    acquire(): AdmissionLease;
}

export interface AdmissionBrokerOptions {
    readonly lookup?: BrokerLookup;
    readonly connector?: BrokerConnector;
    readonly port?: number;
    readonly cacheTtlMs?: number;
}

interface CachedAddresses {
    readonly expiresAt: number;
    readonly addresses: Promise<ReadonlyArray<LookupAddress>>;
}

interface SocksTarget {
    readonly host: string;
    readonly port: number;
    readonly consumed: number;
}

const lookupDefault: BrokerLookup = async (host) => dns.lookup(host, { all: true });

const connectDefault: BrokerConnector = ({ host, port, addresses }) => new Promise((resolve, reject) => {
    const lookup: net.LookupFunction = (_hostname, options, callback) => {
        if (options.all) {
            callback(null, addresses.map(({ address, family }) => ({ address, family })));
            return;
        }
        const first = addresses[0]!;
        callback(null, first.address, first.family);
    };
    const socket = net.connect({ host, port, lookup, autoSelectFamily: true });
    const onError = (cause: Error) => reject(cause);
    socket.once("error", onError);
    socket.once("connect", () => {
        socket.off("error", onError);
        resolve(socket);
    });
});

const closeServer = (server: net.Server): Promise<void> => new Promise((resolve, reject) => {
    if (!server.listening) {
        resolve();
        return;
    }
    server.close((cause) => cause ? reject(cause) : resolve());
});

const closeSocket = (socket: Socket): Promise<void> => {
    if (socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
        socket.once("close", () => resolve());
        socket.destroy();
    });
};

const allCauses = (results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] => results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .flatMap((result) => result.reason instanceof AggregateError
        ? [...result.reason.errors]
        : [result.reason]);

const reply = (code: number): Buffer => Buffer.from([
    SOCKS.version,
    code,
    0x00,
    SOCKS.ipv4,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
]);

const ipv6 = (value: Buffer): string => {
    const groups: string[] = [];
    for (let index = 0; index < 16; index += 2) groups.push(value.readUInt16BE(index).toString(16));
    return groups.join(":");
};

const parseSocksTarget = (buffer: Buffer): SocksTarget | null => {
    if (buffer.length < 4) return null;
    const type = buffer[3];
    let host: string;
    let addressLength: number;
    if (type === SOCKS.ipv4) {
        addressLength = 4;
        if (buffer.length < 4 + addressLength + 2) return null;
        host = [...buffer.subarray(4, 8)].join(".");
    } else if (type === SOCKS.ipv6) {
        addressLength = 16;
        if (buffer.length < 4 + addressLength + 2) return null;
        host = ipv6(buffer.subarray(4, 20));
    } else if (type === SOCKS.domain) {
        if (buffer.length < 5) return null;
        addressLength = buffer[4]!;
        if (addressLength === 0) throw Object.assign(new Error("SOCKS domain is empty"), { reply: SOCKS.addressUnsupported });
        if (buffer.length < 5 + addressLength + 2) return null;
        host = buffer.subarray(5, 5 + addressLength).toString("ascii");
        const portAt = 5 + addressLength;
        const port = buffer.readUInt16BE(portAt);
        if (port === 0) throw Object.assign(new Error("SOCKS port is zero"), { reply: SOCKS.policyRefused });
        return { host, port, consumed: portAt + 2 };
    } else {
        throw Object.assign(new Error(`SOCKS address type ${type} is unsupported`), { reply: SOCKS.addressUnsupported });
    }
    const portAt = 4 + addressLength;
    const port = buffer.readUInt16BE(portAt);
    if (port === 0) throw Object.assign(new Error("SOCKS port is zero"), { reply: SOCKS.policyRefused });
    return { host, port, consumed: portAt + 2 };
};

const socksDisplayUrl = (host: string, port: number): string =>
    `http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}/`;

class BrokerLease implements AdmissionLease {
    readonly #broker: AdmissionBroker;
    #closed = false;

    constructor(broker: AdmissionBroker) {
        this.#broker = broker;
    }

    #assertOpen(): void {
        if (this.#closed) throw new Error("HTTP admission broker lease is closed");
    }

    admit(raw: string): Promise<GuardAdmission> {
        this.#assertOpen();
        return this.#broker.admit(raw);
    }

    localProxyUrl(requireFixedPort = false): Promise<string> {
        this.#assertOpen();
        return this.#broker.localProxyUrl(requireFixedPort);
    }

    dispatcher(): Promise<Dispatcher> {
        this.#assertOpen();
        return this.#broker.dispatcher();
    }

    legacyDispatcher(): Promise<Dispatcher> {
        this.#assertOpen();
        return this.#broker.legacyDispatcher();
    }

    translateTransportError(raw: string, cause: unknown): unknown {
        this.#assertOpen();
        return this.#broker.translateTransportError(raw, cause);
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await this.#broker.release();
    }
}

export default class AdmissionBroker implements AdmissionBoundary {
    readonly #lookup: BrokerLookup;
    readonly #connector: BrokerConnector;
    readonly #port: number | undefined;
    readonly #cacheTtlMs: number;
    readonly #cache = new Map<string, CachedAddresses>();
    readonly #clients = new Set<Socket>();
    readonly #upstreams = new Set<Socket>();
    #leases = 0;
    #server: net.Server | null = null;
    #starting: Promise<void> | null = null;
    #closing: Promise<void> | null = null;
    #agent: Socks5ProxyAgent | null = null;
    #legacy: Dispatcher | null = null;

    constructor({
        lookup = lookupDefault,
        connector = connectDefault,
        port,
        cacheTtlMs = CACHE_TTL_MS,
    }: AdmissionBrokerOptions = {}) {
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
            throw new Error(`Admission broker port ${port} must be an integer from 0 through 65535`);
        }
        if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
            throw new Error(`Admission broker cache TTL ${cacheTtlMs} must be positive`);
        }
        this.#lookup = lookup;
        this.#connector = connector;
        this.#port = port;
        this.#cacheTtlMs = cacheTtlMs;
    }

    acquire(): AdmissionLease {
        this.#leases += 1;
        return new BrokerLease(this);
    }

    async release(): Promise<void> {
        if (this.#leases <= 0) throw new Error("HTTP admission broker lease count underflow");
        this.#leases -= 1;
        if (this.#leases === 0) await this.#shutdown();
    }

    async admit(raw: string): Promise<GuardAdmission> {
        try {
            const target = networkTarget(raw);
            await this.#addresses(target.host, target.url.href);
            return { admitted: true };
        } catch (cause) {
            if (cause instanceof GuardBlockedError || cause instanceof GuardResolutionError) {
                return { admitted: false, error: cause };
            }
            throw cause;
        }
    }

    async localProxyUrl(requireFixedPort = false): Promise<string> {
        if (requireFixedPort && this.#configuredPort() === 0) {
            throw new Error("Browser: remote Chromium requires a nonzero PLURNK_SCHEMES_HTTP_BROKER_PORT forwarding target");
        }
        await this.#ensureStarted();
        const address = this.#server?.address();
        if (address === null || typeof address === "string" || address === undefined) {
            throw new Error("HTTP admission broker did not obtain a TCP listener address");
        }
        return `socks5://${LOOPBACK}:${address.port}`;
    }

    async dispatcher(): Promise<Dispatcher> {
        await this.#ensureStarted();
        if (this.#agent === null) throw new Error("HTTP admission broker dispatcher was not initialized");
        return this.#agent;
    }

    async legacyDispatcher(): Promise<Dispatcher> {
        await this.#ensureStarted();
        if (this.#legacy === null) throw new Error("HTTP admission broker legacy dispatcher was not initialized");
        return this.#legacy;
    }

    translateTransportError(raw: string, cause: unknown): unknown {
        const code = this.#findSocksCode(cause);
        if (code === "UND_ERR_SOCKS5_REPLY_2") return new GuardBlockedError(raw);
        if (code === "UND_ERR_SOCKS5_REPLY_4") return new GuardResolutionError(raw, cause);
        return cause;
    }

    async #addresses(hostRaw: string, displayUrl: string): Promise<ReadonlyArray<LookupAddress>> {
        const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
        if (net.isIP(host) !== 0) {
            if (!isPublicAddress(host)) throw new GuardBlockedError(displayUrl);
            return [{ address: host, family: net.isIP(host) }];
        }
        const now = Date.now();
        const cached = this.#cache.get(host);
        if (cached !== undefined && cached.expiresAt > now) return cached.addresses;
        if (cached !== undefined) this.#cache.delete(host);
        const addresses = (async (): Promise<ReadonlyArray<LookupAddress>> => {
            let answer: ReadonlyArray<LookupAddress>;
            try {
                answer = await this.#lookup(host);
            } catch (cause) {
                throw new GuardResolutionError(displayUrl, cause);
            }
            if (answer.length === 0) {
                throw new GuardResolutionError(
                    displayUrl,
                    new Error(`DNS lookup returned no addresses for ${host}`),
                );
            }
            const normalized = answer.map(({ address }) => ({
                address,
                family: net.isIP(address),
            }));
            if (!normalized.every(({ address }) => isPublicAddress(address))) {
                throw new GuardBlockedError(displayUrl);
            }
            return normalized;
        })();
        const entry = { expiresAt: now + this.#cacheTtlMs, addresses };
        this.#cache.set(host, entry);
        try {
            return await addresses;
        } catch (cause) {
            if (this.#cache.get(host) === entry) this.#cache.delete(host);
            throw cause;
        }
    }

    #configuredPort(): number {
        if (this.#port !== undefined) return this.#port;
        const raw = process.env.PLURNK_SCHEMES_HTTP_BROKER_PORT;
        if (raw === undefined) {
            throw new Error("AdmissionBroker: required env PLURNK_SCHEMES_HTTP_BROKER_PORT is unset — see .env.defaults");
        }
        const port = Number(raw);
        if (!Number.isInteger(port) || port < 0 || port > 65_535) {
            throw new Error(`AdmissionBroker: PLURNK_SCHEMES_HTTP_BROKER_PORT=${raw} must be an integer from 0 through 65535`);
        }
        return port;
    }

    async #ensureStarted(): Promise<void> {
        if (this.#closing !== null) await this.#closing;
        if (this.#server?.listening === true) return;
        if (this.#starting !== null) return this.#starting;
        const start = this.#start();
        this.#starting = start;
        try {
            await start;
        } finally {
            if (this.#starting === start) this.#starting = null;
        }
    }

    async #start(): Promise<void> {
        const server = net.createServer((socket) => this.#accept(socket));
        this.#server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (cause: Error) => reject(cause);
            server.once("error", onError);
            server.listen({ host: LOOPBACK, port: this.#configuredPort() }, () => {
                server.off("error", onError);
                resolve();
            });
        });
        server.unref();
        const address = server.address() as AddressInfo;
        this.#agent = new Socks5ProxyAgent(`socks5://${LOOPBACK}:${address.port}`);
        this.#legacy = new Dispatcher1Wrapper(this.#agent);
    }

    #accept(client: Socket): void {
        this.#clients.add(client);
        client.once("close", () => this.#clients.delete(client));
        let upstream: Socket | null = null;
        let buffer = Buffer.alloc(0);
        let state: "greeting" | "request" | "connecting" | "tunnel" | "closed" = "greeting";
        let processing = false;

        const stop = (code?: number): void => {
            state = "closed";
            upstream?.destroy();
            if (code === undefined || !client.writable) client.destroy();
            else client.end(reply(code));
        };

        let onData: (chunk: Buffer) => void;
        const process = async (): Promise<void> => {
            if (processing || state === "tunnel" || state === "closed") return;
            processing = true;
            try {
                while (true) {
                    if (buffer.length > MAX_PENDING_BYTES) {
                        stop(SOCKS.failure);
                        return;
                    }
                    if (state === "greeting") {
                        if (buffer.length < 2) return;
                        const version = buffer[0];
                        const size = 2 + buffer[1]!;
                        if (buffer.length < size) return;
                        const methods = buffer.subarray(2, size);
                        buffer = buffer.subarray(size);
                        if (version !== SOCKS.version) {
                            stop();
                            return;
                        }
                        if (methods.includes(SOCKS.noAuth) && client.writable) {
                            client.write(Buffer.from([SOCKS.version, SOCKS.noAuth]));
                            state = "request";
                            continue;
                        }
                        client.end(Buffer.from([SOCKS.version, SOCKS.noAcceptableAuth]));
                        return;
                    }
                    if (state === "request") {
                        if (buffer.length < 3) return;
                        if (buffer[0] !== SOCKS.version) {
                            stop(SOCKS.failure);
                            return;
                        }
                        if (buffer[1] !== SOCKS.connect || buffer[2] !== 0x00) {
                            stop(SOCKS.commandUnsupported);
                            return;
                        }
                        let target: SocksTarget | null;
                        try {
                            target = parseSocksTarget(buffer);
                        } catch (cause) {
                            const code = typeof cause === "object" && cause !== null && "reply" in cause
                                ? Number(cause.reply)
                                : SOCKS.failure;
                            stop(code);
                            return;
                        }
                        if (target === null) return;
                        buffer = buffer.subarray(target.consumed);
                        state = "connecting";
                        client.pause();
                        let addresses: ReadonlyArray<LookupAddress>;
                        try {
                            addresses = await this.#addresses(
                                target.host,
                                socksDisplayUrl(target.host, target.port),
                            );
                        } catch (cause) {
                            stop(cause instanceof GuardBlockedError
                                ? SOCKS.policyRefused
                                : cause instanceof GuardResolutionError
                                    ? SOCKS.resolutionFailed
                                    : SOCKS.failure);
                            return;
                        }
                        try {
                            upstream = await this.#connector({
                                host: target.host,
                                port: target.port,
                                addresses,
                            });
                        } catch (cause) {
                            stop(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ECONNREFUSED"
                                ? SOCKS.connectionRefused
                                : SOCKS.failure);
                            return;
                        }
                        this.#upstreams.add(upstream);
                        upstream.once("close", () => this.#upstreams.delete(upstream!));
                        upstream.once("error", () => client.destroy());
                        client.once("error", () => upstream?.destroy());
                        state = "tunnel";
                        client.off("data", onData);
                        client.write(reply(SOCKS.success), () => {
                            if (buffer.length > 0) upstream?.write(buffer);
                            buffer = Buffer.alloc(0);
                            client.pipe(upstream!);
                            upstream!.pipe(client);
                            client.resume();
                        });
                        return;
                    }
                    return;
                }
            } finally {
                processing = false;
            }
        };

        onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            void process().catch((cause: unknown) => {
                console.error("HTTP admission broker client failed", { error: cause });
                stop();
            });
        };
        client.on("data", onData);
        client.once("error", () => upstream?.destroy());
    }

    #findSocksCode(value: unknown, seen: Set<object> = new Set()): string | undefined {
        if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
        seen.add(value);
        if ("code" in value && typeof value.code === "string" && value.code.startsWith("UND_ERR_SOCKS5_")) {
            return value.code;
        }
        if (value instanceof AggregateError) {
            for (const error of value.errors) {
                const found = this.#findSocksCode(error, seen);
                if (found !== undefined) return found;
            }
        }
        return value instanceof Error ? this.#findSocksCode(value.cause, seen) : undefined;
    }

    async #shutdown(): Promise<void> {
        if (this.#closing !== null) return this.#closing;
        const closing = (async () => {
            if (this.#starting !== null) await this.#starting;
            const agent = this.#agent;
            const server = this.#server;
            this.#agent = null;
            this.#legacy = null;
            this.#server = null;
            this.#cache.clear();
            const sockets = [...new Set([...this.#clients, ...this.#upstreams])];
            const results = await Promise.allSettled([
                ...(agent === null ? [] : [agent.destroy(new Error("HTTP admission broker closed"))]),
                ...sockets.map(closeSocket),
                ...(server === null ? [] : [closeServer(server)]),
            ]);
            const errors = allCauses(results);
            if (errors.length > 0) throw new AggregateError(errors, "HTTP admission broker shutdown failed");
        })();
        this.#closing = closing;
        try {
            await closing;
        } finally {
            if (this.#closing === closing) this.#closing = null;
        }
    }
}

export const admissionBroker = new AdmissionBroker();
