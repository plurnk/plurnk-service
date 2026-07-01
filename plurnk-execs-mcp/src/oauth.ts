import {
    discoverOAuthServerInfo,
    registerClient,
    startAuthorization,
    exchangeAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { serverConfig } from "./config.ts";

// Non-interactive OAuth mechanics for http MCP servers (plurnk-execs-mcp#1). The
// executor owns the *protocol* — it already has the SDK, the server config, and
// the transport — while the consumer owns only orchestration (propose the URL
// through its proposal lifecycle) and the client owns the browser leg (a loopback
// `redirectUri`). Two helpers, no interactive round-trip lands here:
//   authorize()    → RFC 9728 discovery + RFC 7591 DCR + PKCE → the URL to open
//   completeAuth() → the authorization-code token exchange → the Bearer headers
// `pkce` is an opaque, JSON-serializable blob the caller round-trips between the
// two calls, so no server-side session is needed.

// A fetch shim so tests (and unusual deployments) can drive the flow without the
// global fetch; every SDK auth primitive accepts one.
type FetchLike = typeof fetch;

// The dynamic-client-registration body for this bridge. `token_endpoint_auth_method:
// "none"` — a public client secured by PKCE, no client secret to store.
const CLIENT_METADATA = Object.freeze({
    client_name: "plurnk-execs-mcp",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
});

// Opaque to the caller: everything completeAuth() needs to finish the exchange,
// carried back verbatim (all JSON-serializable — codeVerifier + client info +
// discovered metadata + the resource URL).
export interface AuthPkce {
    codeVerifier: string;
    clientInformation: OAuthClientInformationFull;
    authorizationServerUrl: string;
    metadata?: AuthorizationServerMetadata;
    resource: string;
}

const httpUrl = (server: string): string => {
    const cfg = serverConfig(server);
    if (cfg === null || cfg.transport !== "http" || cfg.url === undefined) {
        throw new Error(`MCP server '${server}' is not a configured http server — OAuth applies only to http transports`);
    }
    return cfg.url;
};

// Discovery + DCR + PKCE. Returns the authorization URL for the consumer to
// propose, and the opaque `pkce` blob to hand back to completeAuth().
export const authorize = async (
    server: string,
    { redirectUri, fetchFn }: { redirectUri: string; fetchFn?: FetchLike },
): Promise<{ authorizationUrl: string; pkce: AuthPkce }> => {
    const resource = httpUrl(server);
    const { authorizationServerUrl, authorizationServerMetadata } = await discoverOAuthServerInfo(resource, { fetchFn });
    const clientInformation = await registerClient(authorizationServerUrl, {
        metadata: authorizationServerMetadata,
        clientMetadata: { ...CLIENT_METADATA, redirect_uris: [redirectUri] },
        fetchFn,
    });
    const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
        metadata: authorizationServerMetadata,
        clientInformation,
        redirectUrl: redirectUri,
        resource: new URL(resource),
    });
    return {
        authorizationUrl: authorizationUrl.toString(),
        pkce: { codeVerifier, clientInformation, authorizationServerUrl, metadata: authorizationServerMetadata, resource },
    };
};

// The authorization-code → token exchange. Returns the `Authorization: Bearer …`
// headers to inject (the shape Mcp.install() / a `_HEADERS` overlay take). Refresh
// is the same shape once a refresh helper is wired; the token blob carries it.
export const completeAuth = async (
    _server: string,
    { code, pkce, redirectUri, fetchFn }: { code: string; pkce: AuthPkce; redirectUri: string; fetchFn?: FetchLike },
): Promise<{ headers: Record<string, string> }> => {
    const tokens = await exchangeAuthorization(pkce.authorizationServerUrl, {
        metadata: pkce.metadata,
        clientInformation: pkce.clientInformation,
        authorizationCode: code,
        codeVerifier: pkce.codeVerifier,
        redirectUri,
        resource: new URL(pkce.resource),
        fetchFn,
    });
    return { headers: { Authorization: `Bearer ${tokens.access_token}` } };
};
