import type MethodRegistry from "../MethodRegistry.ts";
import { authorize, completeAuth, install } from "@plurnk/plurnk-execs-mcp";

// auth.authorize / auth.authorize.complete (#306) — the service's general, STATELESS URL-auth relay for
// OAuth-protected plugins. The flow is plugin-agnostic: the client owns the browser leg (loopback
// redirect + code capture), the auth-capable plugin owns the mechanics (RFC 9728 discovery / DCR / PKCE
// / token exchange via the SDK), the service passes the pieces between them and injects the bearer.
// `target` is the EXEC tag that needs auth — an MCP server today, another OAuth exec tomorrow. MCP is the
// ONLY auth-capable plugin now, so routing delegates straight to execs-mcp; when a second one lands,
// route `target` by its executor's auth capability — the client contract already fits, only the guts
// grow a branch. No proposal, no re-dispatch, no flow state (the client round-trips the opaque pkce).
type Pkce = Awaited<ReturnType<typeof authorize>>["pkce"];

export default class AuthMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("auth.authorize", {
            handler: async (params) => {
                const p = params as { target?: unknown; redirectUri?: unknown };
                const target = AuthMethod.#target(p.target, "auth.authorize");
                if (typeof p.redirectUri !== "string" || p.redirectUri.length === 0) throw new Error("auth.authorize: redirectUri must be a non-empty string (the client's loopback callback)");
                // execs-mcp does discovery + DCR + PKCE and hands back the URL to open + the opaque pkce
                // blob the client round-trips to complete. The service holds none of it.
                return authorize(target, { redirectUri: p.redirectUri });
            },
            description: "Begin OAuth for a configured auth-capable target (an MCP server today) — returns the authorization URL + an opaque pkce blob to round-trip to auth.authorize.complete.",
            params: { target: "the EXEC tag that needs OAuth", redirectUri: "the client's loopback callback URI" },
            requiresInit: true,
        });
        registry.registerMethod("auth.authorize.complete", {
            handler: async (params) => {
                const p = params as { target?: unknown; code?: unknown; pkce?: unknown; redirectUri?: unknown };
                const target = AuthMethod.#target(p.target, "auth.authorize.complete");
                if (typeof p.code !== "string" || p.code.length === 0) throw new Error("auth.authorize.complete: code must be a non-empty string (from the OAuth redirect)");
                if (p.pkce === null || typeof p.pkce !== "object") throw new Error("auth.authorize.complete: pkce must be the blob returned by auth.authorize");
                if (typeof p.redirectUri !== "string" || p.redirectUri.length === 0) throw new Error("auth.authorize.complete: redirectUri must match the one passed to auth.authorize");
                // Exchange the code for a token, then overlay the bearer on the target's resolved config
                // (install, not registerServer — an env-declared server would shadow a rival injection).
                const { headers } = await completeAuth(target, { code: p.code, pkce: p.pkce as Pkce, redirectUri: p.redirectUri });
                install(target, headers);
                return { ok: true };
            },
            description: "Complete OAuth — exchange the code for a token and inject the bearer, so the next EXEC[target] carries it.",
            params: { target: "the EXEC tag", code: "the authorization code off the redirect", pkce: "the blob from auth.authorize", redirectUri: "the same loopback URI" },
            requiresInit: true,
        });
    }

    static #target(raw: unknown, method: string): string {
        if (typeof raw !== "string" || raw.length === 0) throw new Error(`${method}: target must be a non-empty string`);
        return raw.toLowerCase();
    }
}
