// {§ambient-http-transport} — outbound HTTP and TLS honor the standard ambient proxy and
// certificate-authority environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, both
// cases, and `NODE_EXTRA_CA_CERTS`) across every outbound seam, with zero Plurnk-specific
// proxy or CA knobs. When none are set, global fetch and agent state remain untouched.

import { readFileSync } from "node:fs";
import http from "node:http";
import tls from "node:tls";

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const startupExtra = new Set(tls.getCACertificates("extra"));
const baseCerts = tls.getCACertificates("default").filter((cert) => !startupExtra.has(cert));

let lastCaPath = (process.env.NODE_EXTRA_CA_CERTS ?? "").trim();
let lastProxyKey = "";
let restoreProxy: (() => void) | null = null;

export const syncAmbientHttp = (env: Record<string, string | undefined> = process.env): void => {
    const caPath = (env.NODE_EXTRA_CA_CERTS ?? "").trim();
    if (caPath !== lastCaPath) {
        if (caPath === "") {
            tls.setDefaultCACertificates(baseCerts);
        } else {
            const pem = readFileSync(caPath, "utf8");
            const extra = pem.match(PEM_CERTIFICATE) ?? [];
            tls.setDefaultCACertificates([...baseCerts, ...extra]);
        }
        lastCaPath = caPath;
    }
    const httpProxyUrl = (env.http_proxy ?? env.HTTP_PROXY ?? "").trim();
    const httpsProxyUrl = (env.https_proxy ?? env.HTTPS_PROXY ?? "").trim();
    const noProxyList = (env.no_proxy ?? env.NO_PROXY ?? "").trim();
    const proxyKey = httpProxyUrl === "" && httpsProxyUrl === ""
        ? ""
        : `${caPath}\0${httpProxyUrl}\0${httpsProxyUrl}\0${noProxyList}`;
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
