// The one address predicate and typed target verdict used by the package-owned
// broker {§http-security-boundary}.

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

export const safeUrl = (raw: string): string => {
    try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        return url.href;
    } catch {
        return raw;
    }
};

export class GuardBlockedError extends Error {
    readonly url: string;

    constructor(url: string) {
        const sanitized = safeUrl(url);
        super(`Network guard: ${sanitized} is not an admissible public network target`);
        this.name = "GuardBlockedError";
        this.url = sanitized;
    }
}

export class GuardResolutionError extends Error {
    readonly url: string;

    constructor(url: string, cause: unknown) {
        const sanitized = safeUrl(url);
        super(`Network guard: DNS resolution failed for ${sanitized}`, { cause });
        this.name = "GuardResolutionError";
        this.url = sanitized;
    }
}

export type GuardAdmission =
    | { readonly admitted: true }
    | { readonly admitted: false; readonly error: GuardBlockedError | GuardResolutionError };

export const isPublicAddress = (ip: string): boolean => {
    const family = net.isIP(ip);
    if (family === 0) return false;
    if (family === 4) return !BLOCKED.check(ip, "ipv4");
    if (IPV4_MAPPED.check(ip, "ipv6")) return !BLOCKED.check(ip, "ipv6");
    return GLOBAL_IPV6.check(ip, "ipv6") && !BLOCKED.check(ip, "ipv6");
};

export interface NetworkTarget {
    readonly url: URL;
    readonly host: string;
}

export const networkTarget = (raw: string): NetworkTarget => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new GuardBlockedError(raw);
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        throw new GuardBlockedError(url.href);
    }
    if (url.username !== "" || url.password !== "") throw new GuardBlockedError(url.href);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) {
        throw new GuardBlockedError(url.href);
    }
    return { url, host };
};
