// #235 — version advertising for the client's update notifier. The daemon is the
// long-lived, already-network-capable process, so it owns the registry poll: a one-shot
// CLI does zero registry IO and just renders what `discover` hands it. We self-report the
// installed version and poll npm for `latest` of the service + client packages — CACHED
// (TTL) and BEST-EFFORT (offline / registry-down omits `latest`; never blocks `discover`).

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVICE_PKG = "@plurnk/plurnk-service";
const CLIENT_PKG = "@plurnk/plurnk";

export type Versions = { service: { installed: string; latest?: string }; client: { latest?: string } };

export default class VersionInfo {
    static #installed: string | undefined;
    static #cache: { service?: string; client?: string; at: number } = { service: undefined, client: undefined, at: 0 };
    static #inflight = false;

    // `discover` rides this. Returns immediately with whatever is cached; a stale/cold
    // cache triggers a background refresh (never awaited), so the call never blocks on the
    // network. `installed` is the daemon's honest self-report; `latest` is best-effort.
    static async get(): Promise<Versions> {
        const installed = await VersionInfo.#installedVersion();
        VersionInfo.#maybeRefresh();
        const { service, client } = VersionInfo.#cache;
        return {
            service: service === undefined ? { installed } : { installed, latest: service },
            client: client === undefined ? {} : { latest: client },
        };
    }

    static async #installedVersion(): Promise<string> {
        if (VersionInfo.#installed === undefined) {
            const raw = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
            VersionInfo.#installed = (JSON.parse(raw) as { version: string }).version;
        }
        return VersionInfo.#installed;
    }

    static #maybeRefresh(): void {
        const ttl = VersionInfo.#envMs("PLURNK_SERVICE_VERSION_POLL_TTL", 0);
        const timeout = VersionInfo.#envMs("PLURNK_PROVIDERS_FETCH_TIMEOUT", 1);
        if (VersionInfo.#inflight || Date.now() - VersionInfo.#cache.at < ttl) return;
        VersionInfo.#inflight = true;
        void VersionInfo.#refresh(timeout).finally(() => { VersionInfo.#inflight = false; });
    }

    // No code fallback hides a magic number — the law-file (.env.defaults) carries it.
    static #envMs(name: string, min: number): number {
        const raw = process.env[name];
        const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (ms), got ${JSON.stringify(raw)}`);
        return n;
    }

    static async #refresh(timeout: number): Promise<void> {
        const [service, client] = await Promise.all([VersionInfo.#poll(SERVICE_PKG, timeout), VersionInfo.#poll(CLIENT_PKG, timeout)]);
        // Keep the prior cached value on a failed poll (don't clobber a good `latest` with undefined).
        VersionInfo.#cache = { service: service ?? VersionInfo.#cache.service, client: client ?? VersionInfo.#cache.client, at: Date.now() };
    }

    static async #poll(pkg: string, timeout: number): Promise<string | undefined> {
        try {
            const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(timeout) });
            if (!res.ok) return undefined;
            const body = (await res.json()) as { version?: unknown };
            return typeof body.version === "string" ? body.version : undefined;
        } catch {
            return undefined; // best-effort: offline / registry-down / abort → omit `latest`
        }
    }
}
