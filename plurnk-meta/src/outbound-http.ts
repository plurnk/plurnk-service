// {§ambient-http-transport} — outbound HTTP and TLS honor the OS system certificate store
// (`tls.getCACertificates("system")`, opt-out via `NODE_USE_SYSTEM_CA=0`), `NODE_EXTRA_CA_CERTS`,
// and standard ambient proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, both cases)
// across every outbound seam, with zero Plurnk-specific proxy or CA knobs.

import { readFileSync } from "node:fs";
import http from "node:http";
import tls from "node:tls";

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

const deduplicatePems = (certs: readonly string[]): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const cert of certs) {
        const key = cert.replace(/\s+/gu, "");
        if (!seen.has(key)) {
            seen.add(key);
            out.push(cert);
        }
    }
    return out;
};

let bundledCerts: readonly string[] | null = null;
let systemCombinedCerts: readonly string[] | null = null;

const getBaseCerts = (useSystemCa: boolean): readonly string[] => {
    bundledCerts ??= deduplicatePems(tls.getCACertificates("bundled"));
    if (!useSystemCa) return bundledCerts;
    systemCombinedCerts ??= deduplicatePems([...bundledCerts, ...tls.getCACertificates("system")]);
    return systemCombinedCerts;
};

let lastCaKey = "";
let lastProxyKey = "";
let restoreProxy: (() => void) | null = null;

export const syncAmbientHttp = (env: Record<string, string | undefined> = process.env): void => {
    const useSystemCa = (env.NODE_USE_SYSTEM_CA ?? "").trim() !== "0";
    const caPath = (env.NODE_EXTRA_CA_CERTS ?? "").trim();
    const caKey = `${useSystemCa ? "1" : "0"}\0${caPath}`;
    if (caKey !== lastCaKey) {
        const base = getBaseCerts(useSystemCa);
        if (caPath === "") {
            tls.setDefaultCACertificates(base);
        } else {
            const pem = readFileSync(caPath, "utf8");
            const extra = pem.match(PEM_CERTIFICATE) ?? [];
            tls.setDefaultCACertificates(deduplicatePems([...base, ...extra]));
        }
        lastCaKey = caKey;
    }
    const httpProxyUrl = (env.http_proxy ?? env.HTTP_PROXY ?? "").trim();
    const httpsProxyUrl = (env.https_proxy ?? env.HTTPS_PROXY ?? "").trim();
    const noProxyList = (env.no_proxy ?? env.NO_PROXY ?? "").trim();
    const proxyKey = httpProxyUrl === "" && httpsProxyUrl === ""
        ? ""
        : `${caKey}\0${httpProxyUrl}\0${httpsProxyUrl}\0${noProxyList}`;
    if (proxyKey !== lastProxyKey) {
        restoreProxy?.();
        restoreProxy = proxyKey === "" ? null : http.setGlobalProxyFromEnv(env);
        lastProxyKey = proxyKey;
    }
};

export const outboundFetch: typeof globalThis.fetch = (input, init) => {
    syncAmbientHttp();
    return globalThis.fetch(input, init);
};
