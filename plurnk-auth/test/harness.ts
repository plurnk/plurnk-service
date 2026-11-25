import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialAuthority, CredentialFace } from "@plurnk/plurnk-contracts";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import Module, { type AuthPort, type ModuleOptions } from "../src/Module.ts";

export const FLOOR: NodeJS.ProcessEnv = {
    PLURNK_AUTH_ISSUER: "",
    PLURNK_AUTH_CLIENT_ID: "",
    PLURNK_AUTH_AUDIENCE: "",
    PLURNK_AUTH_CALLBACK: "",
    PLURNK_AUTH_SCOPES: "openid profile email",
    PLURNK_AUTH_USERS: "",
    PLURNK_AUTH_DELEGATES: "",
    PLURNK_AUTH_ALLOW_ORIGIN: "*",
};

export const makeCredentials = (): CredentialAuthority => {
    let published: CredentialFace | null = null;
    return {
        publish(face: CredentialFace): void {
            if (published !== null) throw new Error("A credential face is already published.");
            published = face;
        },
        face(): CredentialFace | null {
            return published;
        },
        async verify(token: string) {
            if (published === null) return null;
            return await published.verify(token);
        },
    };
};

export interface MockOidcProvider {
    readonly issuer: string;
    readonly jwksUri: string;
    sign(claims: Record<string, unknown>, options?: { expiresInSec?: number; useWrongKey?: boolean; omitExp?: boolean; issuer?: string }): Promise<string>;
    setDiscoveryMode(mode: "oidc" | "rfc8414" | "broken" | "mismatch-issuer" | "insecure-jwks"): void;
    close(): Promise<void>;
}

export const startMockOidcProvider = async (pathPrefix = ""): Promise<MockOidcProvider> => {
    const primary = await generateKeyPair("ES256");
    const rogue = await generateKeyPair("ES256");
    const publicJwk: JWK = { ...(await exportJWK(primary.publicKey)), kid: "key-1", alg: "ES256", use: "sig" };

    let discoveryMode: "oidc" | "rfc8414" | "broken" | "mismatch-issuer" | "insecure-jwks" = "oidc";
    let origin = "";
    const normalizedPrefix = pathPrefix.length > 0 && !pathPrefix.startsWith("/") ? `/${pathPrefix}` : pathPrefix;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const issuer = `${origin}${normalizedPrefix}`;
        const jwksUri = `${origin}${normalizedPrefix}/jwks.json`;

        if (pathname === `${normalizedPrefix}/jwks.json`) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [publicJwk] }));
            return;
        }

        const isOidcPath = pathname === `${normalizedPrefix.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
        const isRfc8414Path =
            pathname === `/.well-known/oauth-authorization-server${normalizedPrefix.replace(/\/+$/u, "")}` ||
            pathname === `${normalizedPrefix.replace(/\/+$/u, "")}/.well-known/oauth-authorization-server`;

        if (discoveryMode === "broken" && (isOidcPath || isRfc8414Path)) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unavailable" }));
            return;
        }
        if (discoveryMode === "oidc" && isOidcPath) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer, jwks_uri: jwksUri }));
            return;
        }
        if (discoveryMode === "rfc8414" && isRfc8414Path) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer, jwks_uri: jwksUri }));
            return;
        }
        if (discoveryMode === "mismatch-issuer" && isOidcPath) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer: "https://other-issuer.example.com", jwks_uri: jwksUri }));
            return;
        }
        if (discoveryMode === "insecure-jwks" && isOidcPath) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer, jwks_uri: "http://evil.example.com/jwks.json" }));
            return;
        }

        res.writeHead(404);
        res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    const issuer = `${origin}${normalizedPrefix}`;
    const jwksUri = `${origin}${normalizedPrefix}/jwks.json`;

    return {
        issuer,
        jwksUri,
        setDiscoveryMode(mode) {
            discoveryMode = mode;
        },
        async sign(claims, options = {}) {
            const key = options.useWrongKey === true ? rogue.privateKey : primary.privateKey;
            const jwt = new SignJWT(claims)
                .setProtectedHeader({ alg: "ES256", kid: "key-1" })
                .setIssuer(options.issuer ?? issuer)
                .setIssuedAt();
            if (options.omitExp !== true) {
                const nowSec = Math.floor(Date.now() / 1000);
                jwt.setExpirationTime(nowSec + (options.expiresInSec ?? 300));
            }
            return await jwt.sign(key);
        },
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

export interface HostedAuthModule {
    readonly module: Module;
    readonly base: string;
    readonly credentials: CredentialAuthority;
    close(): Promise<void>;
}

export const bootAuthModule = async (
    env: Record<string, string> = {},
    options: Omit<ModuleOptions, "env"> = {},
): Promise<HostedAuthModule> => {
    const credentials = makeCredentials();
    const mod = Module.create({ env: { ...FLOOR, ...env }, ...options });
    const routes = new Map<string, Parameters<AuthPort["registerHttpRoute"]>[1]>();
    const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        for (const [prefix, handler] of routes) {
            if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
                void handler(req, res);
                return;
            }
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const httpAddress = () => ({ host: "127.0.0.1", port });
    try {
        mod.setup({ credentials, httpAddress });
        mod.start({
            credentials,
            httpAddress,
            registerHttpRoute: (prefix, handler) => {
                routes.set(prefix, handler);
            },
        });
    } catch (error) {
        await mod.close().catch(() => {});
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
    }
    return {
        module: mod,
        base: `http://127.0.0.1:${port}`,
        credentials,
        async close() {
            mod.stop();
            await mod.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};
