import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import Module, { type AuthPort, type ModuleOptions } from "../src/Module.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

export const { default: Credentials } = await import("../../plurnk-core/src/server/Credentials.ts") as {
    default: new (options?: { readonly operatorSecret?: string | null }) => ApplicationPort["credentials"];
};
const { default: HttpListener } = await import("../../plurnk-core/src/server/HttpListener.ts") as {
    default: {
        bind(options: { readonly host: string; readonly port: number }): Promise<{
            httpAddress(): { readonly host: string; readonly port: number };
            registerHttpRoute: ApplicationPort["registerHttpRoute"];
            admit(): void;
            close(): Promise<void>;
        }>;
    };
};
export type Authority = ApplicationPort["credentials"];

export const FLOOR = {
    PLURNK_AUTH: "1", PLURNK_PASS: "lovelace", PLURNK_AUTH_ISSUER: "",
    PLURNK_AUTH_ACCESS_TTL_SEC: "3600", PLURNK_AUTH_REFRESH_TTL_SEC: "2592000",
    PLURNK_AUTH_ALLOW_ORIGIN: "*",
};

export interface Hosted {
    readonly module: Module;
    readonly base: string;
    readonly credentials: Authority;
    close(): Promise<void>;
}

export const boot = async (
    env: Record<string, string> = {}, options: Omit<ModuleOptions, "env"> = {}, operatorSecret: string | null = "s3cret",
    setup: (credentials: Authority) => void = () => {},
): Promise<Hosted> => {
    const credentials = new Credentials({ operatorSecret });
    setup(credentials);
    const mod = Module.create({ env: { ...FLOOR, ...env }, ...options });
    const http = await HttpListener.bind({ host: "127.0.0.1", port: 0 });
    try {
        mod.setup({ credentials, httpAddress: () => http.httpAddress() });
        mod.start({ credentials, httpAddress: () => http.httpAddress(), registerHttpRoute: (prefix, handler) => http.registerHttpRoute(prefix, handler) } satisfies AuthPort);
        http.admit();
    } catch (error) {
        await mod.close().catch(() => {});
        await http.close().catch(() => {});
        throw error;
    }
    const { port } = http.httpAddress();
    return {
        module: mod,
        base: `http://127.0.0.1:${port}`,
        credentials,
        close: async () => {
            mod.stop();
            await mod.close();
            await http.close();
        },
    };
};

export const form = (fields: Record<string, string>): RequestInit => ({
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(),
});
export const basic = (id: string, secret: string): Record<string, string> =>
    ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}` });
export const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => await response.json() as T;
export const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export const admitted = (mod: Hosted, token: string, scope = "acp"): void => {
    const claims = mod.credentials.verify(token);
    assert.ok(claims !== null && claims.kind === "access" && claims.scopes.includes(scope), `expected live access token for ${scope}`);
};
export const rejected = (mod: Hosted, token: string): void => {
    const claims = mod.credentials.verify(token);
    assert.ok(claims === null || claims.kind !== "access", "expected token not to verify as an access token");
};

export const register = async (base: string, redirect: string, extra: Record<string, unknown> = {}): Promise<{ client_id: string }> => {
    const response = await fetch(`${base}/oauth/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [redirect], client_name: "Witness", ...extra }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text) as { client_id: string };
};

export const signIn = async (base: string, query: Record<string, string>, password: string): Promise<Response> => {
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(query).toString()}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<form method="post" action="\/oauth\/authorize">/u);
    for (const [name, value] of Object.entries(query)) {
        assert.ok(html.includes(`name="${name}" value="${value.replaceAll("&", "&amp;")}"`), `the form carries ${name}`);
    }
    return fetch(`${base}/oauth/authorize`, { ...form({ ...query, password }), redirect: "manual" });
};

export const hosted = (base: string, path: string, hostHeader: string): Promise<{ readonly status: number; readonly body: string }> => new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = httpRequest({ host: hostname, port, path, method: "GET", headers: { host: hostHeader } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
});

export const sessionOf = (response: Response): string => {
    const match = /plurnk_session=([^;]+)/u.exec(response.headers.get("set-cookie") ?? "");
    assert.ok(match, `no session cookie: ${response.headers.get("set-cookie")}`);
    return match[1];
};
