import type { TestContext } from "node:test";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "./http-fixture.ts";

export const serveOAuthMcp = async (
    t: TestContext,
    handler: McpHttpHandler,
    options: { metadata?: boolean; registration?: boolean } = {},
): Promise<{ origin: string; served: Awaited<ReturnType<typeof serveMcpHttp>>; tokenRequests: URLSearchParams[] }> => {
    let origin = "";
    const tokenRequests: URLSearchParams[] = [];
    const served = await serveMcpHttp(t, handler, async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
            if (request.headers.get("authorization") === "Bearer access-token") return null;
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
            tokenRequests.push(new URLSearchParams(await request.text()));
            return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 3600, scope: "mcp:read" });
        }
        return new Response("not found", { status: 404 });
    });
    origin = new URL(served.url).origin;
    return { origin, served, tokenRequests };
};
