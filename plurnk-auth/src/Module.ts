import { Problems, requestOrigin, type ProblemDetails, type RequestHeaders } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { IncomingMessage, ServerResponse } from "node:http";
import OidcVerifier from "./OidcVerifier.ts";
import { isLoopbackHost, resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";

export type { ModuleOptions } from "./config.ts";

export type AuthSetupSeam = Pick<ModuleSetupSeam, "credentials" | "httpAddress">;
export type AuthPort = Pick<ApplicationPort, "credentials" | "httpAddress" | "registerHttpRoute">;

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AUTH_MOUNTS = [PROTECTED_RESOURCE_PATH] as const;

const firstHeader = (raw: string | readonly string[] | undefined): string | undefined =>
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

const authProblem = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): ProblemDetails =>
    Problems.create("auth:http", code, status, detail, extensions);

// {§auth-oauth} — optional OIDC / OAuth 2.1 resource-server module.
export default class Module implements DaemonModule<AuthSetupSeam, AuthPort> {
    readonly #opts: ResolvedModuleOptions;
    readonly #verifier: OidcVerifier | null;
    readonly #activeRequests = new Set<Promise<void>>();
    #listener!: AuthSetupSeam["httpAddress"];
    #started = false;
    #stopping = false;
    readonly mounts: readonly string[];

    private constructor(options: ModuleOptions) {
        this.#opts = resolveModuleOptions(options);
        this.mounts = Object.freeze(this.#opts.authenticates ? [...AUTH_MOUNTS] : []);
        this.#verifier = this.#opts.authenticates
            ? new OidcVerifier({
                issuer: this.#opts.issuer,
                audience: this.#opts.audience,
                allowedUsers: this.#opts.allowedUsers,
                ...(this.#opts.fetch === undefined ? {} : { fetch: this.#opts.fetch }),
            })
            : null;
    }

    static create(options: ModuleOptions = {}): Module {
        return new Module(options);
    }

    setup(seam: AuthSetupSeam): void {
        if (this.#started) throw new Error("Cannot call setup() on an already-started Auth Module.");
        this.#listener = () => seam.httpAddress();
        if (this.#verifier !== null) {
            const verifier = this.#verifier;
            seam.credentials.publish({
                issuer: (req) => this.#resourceOrigin(req),
                authorizationServer: this.#opts.issuer,
                verify: (token) => verifier.verify(token),
            });
        }
    }

    start(seam: AuthPort): void {
        if (this.#started) throw new Error("Auth Module is already started.");
        if (!this.#opts.authenticates) {
            this.#started = true;
            return;
        }
        this.#listener = () => seam.httpAddress();
        const route = (req: IncomingMessage, res: ServerResponse): Promise<void> => this.#routeSettled(req, res);
        for (const prefix of AUTH_MOUNTS) seam.registerHttpRoute(prefix, route);
        this.#started = true;
        this.#stopping = false;
    }

    stop(): void {
        this.#stopping = true;
    }

    async close(): Promise<void> {
        this.#stopping = true;
        if (!this.#started) return;
        await Promise.allSettled([...this.#activeRequests]);
        this.#started = false;
        this.#stopping = false;
    }

    // {§http-host} {§auth-oauth} — resolves the daemon's own public resource origin, honoring
    // X-Forwarded-Proto / X-Forwarded-Host when fronted by a local reverse proxy on a loopback listener.
    #resourceOrigin(req: RequestHeaders = { headers: {} }): string {
        const listener = this.#listener();
        if (isLoopbackHost(listener.host)) {
            const proto = firstHeader(req.headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim().toLowerCase();
            const forwardedHost = firstHeader(req.headers["x-forwarded-host"])?.split(",", 1)[0]?.trim();
            const host = forwardedHost && forwardedHost.length > 0 ? forwardedHost : firstHeader(req.headers.host)?.trim();
            if ((proto === "https" || proto === "http") && host !== undefined && host.length > 0) {
                try {
                    return `${proto}://${new URL(`${proto}://${host}`).host}`;
                } catch {
                    // Fall back to direct listener requestOrigin below on malformed forwarded Host.
                }
            }
        }
        return requestOrigin(req, listener);
    }

    #corsHeaders(): Record<string, string> {
        const origin = this.#opts.allowOrigin;
        if (origin.length === 0) return {};
        return {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, HEAD, OPTIONS",
            "access-control-allow-headers": "authorization, accept",
        };
    }

    #writeProblem(res: ServerResponse, status: number, problem: ProblemDetails, extraHeaders: Readonly<Record<string, string>> = {}): void {
        const body = JSON.stringify(problem);
        res.writeHead(status, {
            "content-type": "application/problem+json",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
            ...this.#corsHeaders(),
            ...extraHeaders,
        });
        res.end(body);
    }

    #routeSettled(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const settled = this.#route(req, res).finally(() => {
            this.#activeRequests.delete(settled);
        });
        this.#activeRequests.add(settled);
        return settled;
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopping) {
            this.#writeProblem(res, 503, authProblem("service-stopping", 503, "The service is shutting down.", { stage: "shutdown", retryable: true }));
            return;
        }
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "cache-control": "no-store",
                ...this.#corsHeaders(),
            });
            res.end();
            return;
        }
        const pathname = new URL(req.url ?? "/", "http://listener").pathname;
        if (pathname !== PROTECTED_RESOURCE_PATH) {
            this.#writeProblem(res, 404, authProblem("route-not-found", 404, "The requested HTTP route does not exist.", { stage: "routing", retryable: false }));
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            this.#writeProblem(
                res,
                405,
                authProblem("method-not-allowed", 405, "Only GET, HEAD, and OPTIONS are supported on protected resource metadata.", { stage: "routing", retryable: false }),
                { allow: "GET, HEAD, OPTIONS" },
            );
            return;
        }

        const resourceOrigin = this.#resourceOrigin(req);
        const metadata = {
            resource: resourceOrigin,
            authorization_servers: [this.#opts.issuer],
            scopes_supported: this.#opts.scopes,
            bearer_methods_supported: ["header"],
            resource_name: "Plurnk",
            ...(this.#opts.clientId.length > 0 ? { client_id: this.#opts.clientId } : {}),
            redirect_uri: this.#opts.callbackUrl.length > 0 ? this.#opts.callbackUrl : `${resourceOrigin}/auth/callback`,
        };
        const body = JSON.stringify(metadata);
        res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(body),
            "cache-control": "no-store",
            ...this.#corsHeaders(),
        });
        res.end(req.method === "HEAD" ? undefined : body);
    }
}
