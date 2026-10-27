import { Problems, requestOrigin, type ProblemDetails, type RequestHeaders } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";
import type { IncomingMessage, ServerResponse } from "node:http";
import OAuthServer from "./OAuthServer.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";

export type { DeclaredClient, ModuleOptions } from "./config.ts";

export type AuthSetupSeam = Pick<ApplicationPort, "credentials" | "httpAddress">;
export type AuthPort = Pick<ApplicationPort, "credentials" | "httpAddress" | "registerHttpRoute">;

const OAUTH_MOUNTS = ["/oauth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"] as const;

const authProblem = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): ProblemDetails =>
    Problems.create("auth:http", code, status, detail, extensions);

// {§auth-oauth} — the daemon's OAuth 2.1 authorization server module.
export default class Module implements DaemonModule<AuthSetupSeam, AuthPort> {
    readonly #opts: ResolvedModuleOptions;
    readonly #activeRequests = new Set<Promise<void>>();
    #listener!: AuthSetupSeam["httpAddress"];
    #oauth: OAuthServer | null = null;
    #started = false;
    #stopping = false;
    readonly mounts: readonly string[];

    private constructor(options: ModuleOptions) {
        this.#opts = resolveModuleOptions(options);
        this.mounts = Object.freeze(this.#opts.authenticates ? [...OAUTH_MOUNTS] : []);
    }

    static create(options: ModuleOptions = {}): Module {
        return new Module(options);
    }

    setup(seam: AuthSetupSeam): void {
        if (this.#started) throw new Error("Cannot call setup() on an already-started Auth Module.");
        this.#listener = () => seam.httpAddress();
        // {§auth-oauth} {§credential-authority} — publish the authority's issuing face at setup so
        // every module may read the issuer from its start on ({§module-contract}).
        if (this.#opts.authenticates) {
            this.#oauth ??= new OAuthServer({ credentials: seam.credentials, opts: this.#opts, issuer: (req) => this.#origin(req) });
            seam.credentials.publish({ issuer: (req) => this.#origin(req) });
        }
    }

    start(seam: AuthPort): void {
        if (this.#started) throw new Error("Auth Module is already started.");
        if (!this.#opts.authenticates) {
            this.#started = true;
            return;
        }
        this.#listener = () => seam.httpAddress();
        this.#oauth ??= new OAuthServer({ credentials: seam.credentials, opts: this.#opts, issuer: (req) => this.#origin(req) });
        const route = (req: IncomingMessage, res: ServerResponse): Promise<void> => this.#routeSettled(req, res);
        for (const prefix of OAUTH_MOUNTS) seam.registerHttpRoute(prefix, route);
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

    // {§http-host} — the configured public origin when one is set, else the origin the
    // request reached, else the listener's own when asked with no request in hand.
    #origin(req: RequestHeaders = { headers: {} }): string {
        return this.#opts.issuer.length > 0 ? this.#opts.issuer : requestOrigin(req, this.#listener());
    }

    // {§auth-oauth} — CORS headers from PLURNK_AUTH_ALLOW_ORIGIN.
    #corsHeaders(): Record<string, string> {
        const origin = this.#opts.allowOrigin;
        if (origin.length === 0) return {};
        return {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "content-type, authorization, accept",
        };
    }

    #writeProblem(res: ServerResponse, status: number, problem: ProblemDetails): void {
        const body = JSON.stringify(problem);
        res.writeHead(status, {
            "content-type": "application/problem+json",
            "content-length": Buffer.byteLength(body),
            ...this.#corsHeaders(),
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
            // {§auth-oauth}
            this.#writeProblem(res, 503, authProblem("service-stopping", 503, "The service is shutting down.", { stage: "shutdown", retryable: true }));
            return;
        }
        for (const [name, value] of Object.entries(this.#corsHeaders())) res.setHeader(name, value);
        if (req.method === "OPTIONS") {
            res.writeHead(204, this.#corsHeaders());
            res.end();
            return;
        }
        if (this.#oauth !== null && await this.#oauth.handle(req, res)) return;
        // {§auth-oauth}
        this.#writeProblem(res, 404, authProblem("route-not-found", 404, "The requested HTTP route does not exist.", {
            method: req.method ?? null,
            path: req.url ?? null,
            stage: "routing",
            retryable: false,
        }));
    }
}
