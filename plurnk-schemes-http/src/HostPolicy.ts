// {§http-host-policy} — the operator may confine every web acquisition to named hosts. Unset (or
// empty) admits every host, as before; a JSON array admits exactly its members: `"example.com"`
// names that host, `"*.example.com"` any subdomain of it, and `[]` names none. It is operator
// policy beside {§automatic-fetch-check}, never a model-facing teaching; an isolated benchmark sets [].
export const HOSTS_ENV = "PLURNK_SCHEMES_HTTP_HOSTS";

export class HostPolicyError extends Error {
    readonly host: string;
    constructor(host: string) {
        super(`${host} is outside the operator's web host policy`);
        this.name = "HostPolicyError";
        this.host = host;
    }
}

export default class HostPolicy {
    // null: no policy (every host); otherwise the admitted patterns.
    static patterns(): readonly string[] | null {
        const raw = process.env[HOSTS_ENV];
        if (raw === undefined || raw.trim() === "") return null;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (cause) { throw new Error(`${HOSTS_ENV} must be a JSON array of host names`, { cause }); }
        if (!Array.isArray(parsed) || !parsed.every((host) => typeof host === "string" && host.length > 0)) {
            throw new Error(`${HOSTS_ENV} must be a JSON array of host names`);
        }
        return parsed.map((host: string) => host.toLowerCase());
    }

    static permits(raw: string): boolean {
        const patterns = HostPolicy.patterns();
        if (patterns === null) return true;
        let host: string;
        try { host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, ""); }
        catch { return false; }
        return patterns.some((pattern) => pattern.startsWith("*.")
            ? host.endsWith(pattern.slice(1))
            : host === pattern);
    }

    static require(raw: string): void {
        if (HostPolicy.permits(raw)) return;
        let host = raw;
        try { host = new URL(raw).hostname; } catch { /* the unparsable target is named as written */ }
        throw new HostPolicyError(host);
    }
}
