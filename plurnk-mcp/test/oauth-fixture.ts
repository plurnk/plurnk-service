import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "./http-fixture.ts";

export const serveOAuthMcp = async (
    t: TestContext,
    handler: McpHttpHandler,
    options: { metadata?: boolean; registration?: boolean; code?: string } = {},
): Promise<{ origin: string; served: Awaited<ReturnType<typeof serveMcpHttp>>; tokenRequests: URLSearchParams[]; revoke: () => void }> => {
    let origin = "";
    let exchanged = false;
    let accessToken = crypto.randomUUID();
    const tokenRequests: URLSearchParams[] = [];
    const served = await serveMcpHttp(t, handler, async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
            if (exchanged && request.headers.get("authorization") === `Bearer ${accessToken}`) return null;
            return new Response("unauthorized", {
                status: 401,
                headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
            });
        }
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
            return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"] });
        }
        if (url.pathname === "/.well-known/oauth-authorization-server" && options.metadata !== false) {
            return Response.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
                client_id_metadata_document_supported: true,
                ...(options.registration === false ? {} : { registration_endpoint: `${origin}/register` }),
                authorization_response_iss_parameter_supported: true,
            });
        }
        if (url.pathname === "/register") {
            return Response.json({ ...await request.json(), client_id: "registered-fixture", token_endpoint_auth_method: "none" });
        }
        if (url.pathname === "/token") {
            const params = new URLSearchParams(await request.text());
            tokenRequests.push(params);
            if (exchanged || params.get("grant_type") !== "authorization_code" || params.get("code") !== (options.code ?? "fixture-code")) {
                return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            exchanged = true;
            return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    // The grant lapses: its token is refused from now on, and a fresh sign-in may exchange the code again.
    const revoke = (): void => {
        exchanged = false;
        accessToken = crypto.randomUUID();
    };
    return { origin, served, tokenRequests, revoke };
};

// A resource server that answers its catalog to anyone, refuses a tool call without its bearer token, and publishes no
// OAuth metadata, beside an OpenID authorization server at its own origin that registers no clients and issues a refresh
// token only when the authorization request asks for offline access — the shape of Google's hosted Workspace servers.
export const serveIssuerOAuth = async (
    t: TestContext,
    handler: McpHttpHandler,
    client: { id: string; secret: string },
): Promise<{
    resource: string;
    issuer: string;
    authorizations: URLSearchParams[];
    tokenRequests: URLSearchParams[];
    expire: () => void;
    revoke: () => void;
}> => {
    const authorizations: URLSearchParams[] = [];
    const tokenRequests: URLSearchParams[] = [];
    const codes = new Map<string, { challenge: string; redirectUri: string; offline: boolean }>();
    const refreshTokens = new Set<string>();
    let accessToken: string | undefined;
    const issue = (offline: boolean): Response => {
        accessToken = crypto.randomUUID();
        const refreshToken = offline ? crypto.randomUUID() : undefined;
        if (refreshToken !== undefined) refreshTokens.add(refreshToken);
        return Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }) });
    };
    const authorizationServer = createServer((incoming, outgoing) => {
        void (async () => {
            const url = new URL(incoming.url ?? "/", issuer);
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const respond = async (response: Response): Promise<void> => {
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                outgoing.end(Buffer.from(await response.arrayBuffer()));
            };
            if (url.pathname === "/.well-known/openid-configuration") {
                return respond(Response.json({
                    issuer,
                    authorization_endpoint: `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/jwks`,
                    response_types_supported: ["code"],
                    subject_types_supported: ["public"],
                    id_token_signing_alg_values_supported: ["RS256"],
                    code_challenge_methods_supported: ["S256"],
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
                    scopes_supported: ["openid", "email"],
                }));
            }
            if (url.pathname === "/authorize") {
                const params = url.searchParams;
                authorizations.push(params);
                const redirectUri = params.get("redirect_uri");
                const challenge = params.get("code_challenge");
                if (params.get("client_id") !== client.id || params.get("response_type") !== "code" || redirectUri === null || challenge === null) {
                    return respond(new Response("invalid request", { status: 400 }));
                }
                const code = crypto.randomUUID();
                codes.set(code, { challenge, redirectUri, offline: params.get("access_type") === "offline" });
                const callback = new URL(redirectUri);
                callback.searchParams.set("code", code);
                callback.searchParams.set("state", params.get("state") ?? "");
                return respond(new Response(null, { status: 302, headers: { location: callback.href } }));
            }
            if (url.pathname === "/token" && incoming.method === "POST") {
                const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
                tokenRequests.push(params);
                const basic = incoming.headers.authorization?.startsWith("Basic ")
                    ? Buffer.from(incoming.headers.authorization.slice(6), "base64").toString("utf8").split(":").map(decodeURIComponent)
                    : [params.get("client_id"), params.get("client_secret")];
                if (basic[0] !== client.id || basic[1] !== client.secret) return respond(Response.json({ error: "invalid_client" }, { status: 401 }));
                if (params.get("grant_type") === "refresh_token") {
                    const refreshToken = params.get("refresh_token");
                    if (refreshToken === null || !refreshTokens.has(refreshToken)) return respond(Response.json({ error: "invalid_grant" }, { status: 400 }));
                    accessToken = crypto.randomUUID();
                    return respond(Response.json({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }));
                }
                const grant = codes.get(params.get("code") ?? "");
                codes.delete(params.get("code") ?? "");
                const verifier = params.get("code_verifier") ?? "";
                if (params.get("grant_type") !== "authorization_code" || grant === undefined || grant.redirectUri !== params.get("redirect_uri")
                    || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) {
                    return respond(Response.json({ error: "invalid_grant" }, { status: 400 }));
                }
                return respond(issue(grant.offline));
            }
            return respond(new Response("not found", { status: 404 }));
        })();
    });
    authorizationServer.listen(0, "127.0.0.1");
    await once(authorizationServer, "listening");
    t.after(() => new Promise<void>((resolve) => { authorizationServer.closeAllConnections(); authorizationServer.close(() => resolve()); }));
    const issuer = `http://127.0.0.1:${(authorizationServer.address() as AddressInfo).port}`;
    const served = await serveMcpHttp(t, handler, async (request) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/.well-known/")) return new Response("not found", { status: 404 });
        if (request.method !== "POST") return null;
        const body = await request.clone().json().catch(() => null) as { method?: unknown; id?: unknown } | null;
        if (body?.method !== "tools/call" || (accessToken !== undefined && request.headers.get("authorization") === `Bearer ${accessToken}`)) return null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32001, message: "Request is missing required authentication credential." } }),
            { status: 401, headers: { "content-type": "application/json" } });
    });
    return {
        resource: served.url,
        issuer,
        authorizations,
        tokenRequests,
        // The access token lapses; a refresh token, where one was issued, still answers.
        expire: () => { accessToken = crypto.randomUUID(); },
        // The grant is revoked: its access token lapses and its refresh tokens are refused as invalid grants.
        revoke: () => { accessToken = crypto.randomUUID(); refreshTokens.clear(); },
    };
};
