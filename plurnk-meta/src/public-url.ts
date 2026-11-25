// {§ambient-http-transport} — canonical public-address SSRF guard shared across
// outbound HTTP, WebSocket, MCP, and Skills transports. Static protocol ranges
// only; operator host allowlists remain owned by each consuming package.

import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED = new net.BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

const IPV4_MAPPED = new net.BlockList();
IPV4_MAPPED.addSubnet("0.0.0.0", 0, "ipv4");
const GLOBAL_IPV6 = new net.BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");

const HTTP_PROTOCOLS: readonly string[] = ["http:", "https:"];

const safeUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        return url.href;
    } catch {
        return raw;
    }
};

export interface PublicUrlOptions {
    readonly protocols?: readonly string[];
}

// A target (or redirect hop) rejected by the public-address SSRF guard.
export class GuardBlockedError extends Error {
    readonly url: string;
    constructor(url: string) {
        const sanitized = safeUrl(url);
        super(`Public URL guard: ${sanitized} is not a public target`);
        this.name = "GuardBlockedError";
        this.url = sanitized;
    }
}

// Static protocol ranges, not operator policy. IPv4-mapped IPv6 is checked
// against the same v4 block list after WHATWG URL canonicalization.
export const isPublicAddress = (ip: string): boolean => {
    const family = net.isIP(ip);
    if (family === 0) return false;
    if (family === 4) return !BLOCKED.check(ip, "ipv4");
    if (IPV4_MAPPED.check(ip, "ipv6")) return !BLOCKED.check(ip, "ipv6");
    return GLOBAL_IPV6.check(ip, "ipv6") && !BLOCKED.check(ip, "ipv6");
};

// Credential-free permitted protocol, no localhost, and EVERY resolved address
// public. An IP literal skips DNS; a hostname resolves and every A/AAAA must be public.
export const isPublicUrl = async (raw: string, options: PublicUrlOptions = {}): Promise<boolean> => {
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    const protocols = options.protocols ?? HTTP_PROTOCOLS;
    if (!protocols.includes(url.protocol)) return false;
    if (url.username !== "" || url.password !== "") return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (net.isIP(host)) return isPublicAddress(host);
    try {
        const addrs = await dns.lookup(host, { all: true });
        return addrs.length > 0 && addrs.every(({ address }) => isPublicAddress(address));
    } catch {
        return false;
    }
};
