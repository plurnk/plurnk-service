// The mock OAuth server behind the #306 relay e2e (RFC 9728 discovery → auth-server metadata →
// DCR → authorize → token), shared by the intg test and the bootable CLI (bin/mock-oauth.ts) the
// client's cross-stack /auth validation drives (plurnk#116). ONE implementation — the joint e2e
// and our own must prove the same server.
//
// /authorize is a real endpoint here (the intg test skips it — it hands `complete` a code
// directly): it immediately 302s to the caller's redirect_uri with a code + the echoed state,
// standing in for the human consent page so a full client flow needs no browser.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const mockOAuthServer = async (): Promise<{ server: Server; base: string }> => {
    const server = createServer((req, res) => {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const send = (body: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        const url = req.url ?? "";
        if (url.includes("oauth-protected-resource")) return send({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) return send({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
        if (url.includes("/register")) return send({ client_id: "test-client-id", redirect_uris: ["http://127.0.0.1:9876/callback"], token_endpoint_auth_method: "none" });
        if (url.startsWith("/authorize")) {
            const q = new URL(url, base).searchParams;
            const redirect = new URL(q.get("redirect_uri") ?? "http://127.0.0.1:9876/callback");
            redirect.searchParams.set("code", "auth-code-xyz");
            const state = q.get("state");
            if (state !== null) redirect.searchParams.set("state", state);
            res.writeHead(302, { location: redirect.toString() });
            return res.end();
        }
        if (url.includes("/token")) return send({ access_token: "tok-abc123", token_type: "Bearer", expires_in: 3600 });
        res.writeHead(404); res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
