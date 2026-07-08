import type MethodRegistry from "../MethodRegistry.ts";
import { authorize, poll, install } from "@plurnk/plurnk-execs-mcp";
import type { AuthDevice } from "@plurnk/plurnk-execs-mcp";

// auth.authorize / auth.authorize.poll (#306, #353) — the service's general, STATELESS URL-auth relay
// for OAuth-protected plugins, on the RFC 8628 Device Authorization Grant (execs-mcp 0.6.0). No
// redirect, no loopback server: the loopback flow was structurally broken for remote daemons (the
// provider redirected to 127.0.0.1 on the DAEMON host, unreachable from the user's browser on a
// bastion/jumpbox). Now the plugin does discovery + DCR + the device-authorization request; the
// service passes the pieces between plugin and client and injects the bearer; the CLIENT drives the
// poll loop (honoring `interval`, backing off on `slow_down`), round-tripping the opaque `device`
// blob — so the relay holds NO flow state and hosts no HTTP callback. `target` is the EXEC tag that
// needs auth (an MCP server today); MCP is the only auth-capable plugin, so routing delegates straight
// to execs-mcp — when a second lands, route `target` by its executor's auth capability.

export default class AuthMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("auth.authorize", {
            handler: async (params) => {
                const p = params as { target?: unknown };
                const target = AuthMethod.#target(p.target, "auth.authorize");
                // execs-mcp does discovery + DCR + the device-authorization request and hands back the
                // verification URL + user code to display, the poll interval, and the opaque `device`
                // blob the client round-trips to poll. Fails hard if the provider offers no device
                // endpoint (no fallback — owner ruling). The service holds none of it.
                return authorize(target);
            },
            description: "Begin device-grant OAuth for an auth-capable target (an MCP server today) — returns { verificationUri, verificationUriComplete?, userCode, interval, expiresIn, device }; display the URL + code, then drive auth.authorize.poll with the opaque device blob.",
            params: { target: "the EXEC tag that needs OAuth" },
            requiresInit: true,
        });
        registry.registerMethod("auth.authorize.poll", {
            handler: async (params) => {
                const p = params as { target?: unknown; device?: unknown };
                const target = AuthMethod.#target(p.target, "auth.authorize.poll");
                if (p.device === null || typeof p.device !== "object") throw new Error("auth.authorize.poll: device must be the opaque blob returned by auth.authorize");
                // One device-token poll. On authorization, overlay the bearer on the target's resolved
                // config (install, not registerServer — an env-declared server would shadow a rival
                // injection) BEFORE returning, so the next EXEC[target] carries it. Any other status
                // passes back verbatim; the client honors `interval`/`slow_down` and polls again.
                const result = await poll(target, { device: p.device as AuthDevice });
                if (result.status === "authorized" && result.headers !== undefined) install(target, result.headers);
                return { status: result.status };
            },
            description: "Poll the device grant once. status ∈ pending | slow_down | authorized | denied | expired; on 'authorized' the bearer is injected so the next EXEC[target] carries it. The client drives the loop, honoring interval and backing off on slow_down.",
            params: { target: "the EXEC tag", device: "the opaque device blob from auth.authorize" },
            requiresInit: true,
        });
    }

    static #target(raw: unknown, method: string): string {
        if (typeof raw !== "string" || raw.length === 0) throw new Error(`${method}: target must be a non-empty string`);
        return raw.toLowerCase();
    }
}
