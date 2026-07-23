import {
    discoverOAuthServerInfo,
    registerClient,
    type AuthorizationServerMetadata,
} from "@modelcontextprotocol/client";
import { serverConfig } from "./config.ts";

// Device Authorization Grant (RFC 8628) OAuth for http MCP servers
// (plurnk-execs-mcp#2). Replaces the loopback authorization-code flow, which
// assumed the browser and the daemon were co-located: after consent the provider
// redirected to `http://127.0.0.1:<port>` on the DAEMON host — unreachable from a
// user's local browser when the daemon runs remote (SSH/bastion/jumpbox, the
// primary deployment), so the leg hung to timeout. The device grant has NO
// redirect and NO local server — the user approves a short code on any device:
//   authorize() → discovery + DCR + a device-authorization request → { verificationUri, userCode, device }
//   poll()      → a device-token request, polled → pending / slow_down / authorized(headers) / denied / expired
// `device` is an opaque, JSON-serializable blob the caller round-trips from
// authorize() into each poll(): the flow is stateless server-side; the CALLER
// drives the poll loop, honoring `interval` — and on `slow_down` MUST add 5
// seconds to the interval for all subsequent polls (RFC 8628 §3.5, exact).

type FetchLike = typeof fetch;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// DCR body: a public client registered for the device-code + refresh grants. The
// device grant never redirects — `redirect_uris` is empty (the SDK's RFC 7591
// type requires the field, but no redirect grant is registered, so no URI is
// used). The out-of-band user approval is the security boundary: no client
// secret, no redirect-interception vector, so no PKCE either.
const CLIENT_METADATA = Object.freeze({
    client_name: "plurnk-execs-mcp",
    grant_types: [DEVICE_GRANT, "refresh_token"],
    token_endpoint_auth_method: "none",
    redirect_uris: [] as string[],
});

// Opaque to the caller: everything poll() needs to hit the token endpoint,
// carried back verbatim from authorize() (all JSON-serializable).
export interface AuthDevice {
    deviceCode: string;
    clientId: string;
    tokenEndpoint: string;
}

export type PollStatus = "pending" | "slow_down" | "authorized" | "denied" | "expired";

const httpUrl = (server: string): string => {
    const cfg = serverConfig(server);
    if (cfg === null || cfg.transport !== "http" || cfg.url === undefined) {
        throw new Error(`MCP server '${server}' is not a configured http server — OAuth applies only to http transports`);
    }
    return cfg.url;
};

const postForm = (fetchFn: FetchLike, url: string, fields: Record<string, string>): Promise<Response> =>
    fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(fields).toString(),
    });

// Discovery + DCR + the RFC 8628 device-authorization request. Returns what to
// SHOW the user (verification URL + short code) and the opaque `device` blob to
// hand back to poll(). Fails hard when the authorization server advertises no
// `device_authorization_endpoint`: the device grant is required for remote
// clients and there is no fallback (loopback retired, OOB deprecated).
export const authorize = async (
    server: string,
    { scope, fetchFn }: { scope?: string; fetchFn?: FetchLike } = {},
): Promise<{
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
    interval: number;
    expiresIn: number;
    device: AuthDevice;
}> => {
    const resource = httpUrl(server);
    const doFetch = fetchFn ?? fetch;
    const { authorizationServerUrl, authorizationServerMetadata } = await discoverOAuthServerInfo(resource, { fetchFn });
    // The SDK parses AS metadata with a passthrough (`z.looseObject`) schema, so
    // `device_authorization_endpoint` survives even though it is untyped.
    const metadata = authorizationServerMetadata as (AuthorizationServerMetadata & { device_authorization_endpoint?: string }) | undefined;
    if (!metadata || typeof metadata.device_authorization_endpoint !== "string") {
        throw new Error(`MCP server '${server}' authorization server does not support the Device Authorization Grant (no device_authorization_endpoint, RFC 8628) — required for remote clients, no fallback`);
    }
    const clientInformation = await registerClient(authorizationServerUrl, {
        metadata: authorizationServerMetadata,
        clientMetadata: CLIENT_METADATA,
        fetchFn,
    });
    const res = await postForm(doFetch, metadata.device_authorization_endpoint, {
        client_id: clientInformation.client_id,
        resource,
        ...(scope ? { scope } : {}),
    });
    if (!res.ok) throw new Error(`device authorization request failed for '${server}': ${res.status} ${await res.text()}`);
    const body = await res.json() as {
        device_code: string; user_code: string; verification_uri: string;
        verification_uri_complete?: string; expires_in: number; interval?: number;
    };
    return {
        verificationUri: body.verification_uri,
        ...(body.verification_uri_complete ? { verificationUriComplete: body.verification_uri_complete } : {}),
        userCode: body.user_code,
        interval: body.interval ?? 5,
        expiresIn: body.expires_in,
        device: { deviceCode: body.device_code, clientId: clientInformation.client_id, tokenEndpoint: String(metadata.token_endpoint) },
    };
};

// One device-token poll (RFC 8628 §3.4). The CALLER drives the loop, honoring the
// `interval` from authorize(); on `slow_down` it MUST add 5 seconds to the
// interval for this and all subsequent polls (§3.5). `authorized` carries
// the Bearer headers (the shape Mcp.install() takes); `denied`/`expired` are
// terminal; `pending`/`slow_down` mean poll again. A non-standard error throws.
export const poll = async (
    server: string,
    { device, fetchFn }: { device: AuthDevice; fetchFn?: FetchLike },
): Promise<{ status: PollStatus; headers?: Record<string, string> }> => {
    const doFetch = fetchFn ?? fetch;
    const res = await postForm(doFetch, device.tokenEndpoint, {
        grant_type: DEVICE_GRANT,
        device_code: device.deviceCode,
        client_id: device.clientId,
    });
    const body = await res.json() as { access_token?: string; error?: string };
    if (res.ok && typeof body.access_token === "string") {
        return { status: "authorized", headers: { Authorization: `Bearer ${body.access_token}` } };
    }
    switch (body.error) {
        case "authorization_pending": return { status: "pending" };
        case "slow_down": return { status: "slow_down" };
        case "access_denied": return { status: "denied" };
        case "expired_token": return { status: "expired" };
        default: throw new Error(`device token poll failed for '${server}': ${body.error ?? `HTTP ${res.status}`}`);
    }
};
