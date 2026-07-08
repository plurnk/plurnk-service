// The mock OAuth server behind the #353 relay e2e — RFC 8628 Device Authorization Grant (RFC 9728
// discovery → auth-server metadata with a device_authorization_endpoint → DCR → device-authorization
// request → device-token polling). No /authorize, no redirect: the loopback flow retired (broken for
// remote daemons). Shared by the intg test and the bootable CLI (bin/mock-oauth.ts) the client's
// cross-stack /auth validation drives — ONE implementation, both prove the same server.
//
// /token returns `authorization_pending` on the first poll and the token thereafter, so the e2e
// exercises the client's poll loop (pending → authorized), not a one-shot exchange.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const mockOAuthServer = async (): Promise<{ server: Server; base: string }> => {
    let polls = 0;
    const server = createServer((req, res) => {
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const send = (body: unknown): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        const err = (error: string): void => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); };
        const url = req.url ?? "";
        if (url.includes("oauth-protected-resource")) return send({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) return send({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            device_authorization_endpoint: `${base}/device_authorization`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
        if (url.includes("/register")) return send({ client_id: "test-client-id", redirect_uris: [], grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"], token_endpoint_auth_method: "none" });
        if (url.includes("/device_authorization")) return send({
            device_code: "dev-code-xyz",
            user_code: "WDJB-MJHT",
            verification_uri: `${base}/device`,
            verification_uri_complete: `${base}/device?user_code=WDJB-MJHT`,
            interval: 1,
            expires_in: 600,
        });
        // The poll: pending until the "user" approves (the second poll here), then the token.
        if (url.includes("/token")) return ++polls < 2 ? err("authorization_pending") : send({ access_token: "tok-abc123", token_type: "Bearer", expires_in: 3600 });
        res.writeHead(404); res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
