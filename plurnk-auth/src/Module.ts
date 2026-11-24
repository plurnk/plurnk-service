import {
    Problems,
    buildCorsHeaders,
    resolvePublicOrigin,
    type ProblemDetails,
    type RequestHeaders,
} from "@plurnk/plurnk-contracts";
import { InFlightTracker, writeHttpProblem, type ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import type { IncomingMessage, ServerResponse } from "node:http";
import OidcVerifier from "./OidcVerifier.ts";
import { resolveModuleOptions, type ModuleOptions, type ResolvedModuleOptions } from "./config.ts";

export type { ModuleOptions } from "./config.ts";

export type AuthSetupSeam = Pick<ModuleSetupSeam, "credentials" | "httpAddress">;
export type AuthPort = Pick<ApplicationPort, "credentials" | "httpAddress" | "registerHttpRoute">;

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AUTH_MOUNTS = [PROTECTED_RESOURCE_PATH] as const;

const authProblem = (code: string, status: number, detail: string, extensions: Readonly<Record<string, unknown>> = {}): ProblemDetails =>
    Problems.create("auth:http", code, status, detail, extensions);

// {§auth-oauth} — optional OIDC / OAuth 2.1 resource-server module.
export default class Module implements DaemonModule<AuthSetupSeam, AuthPort> {
    readonly #opts: ResolvedModuleOptions;
    readonly #verifier: OidcVerifier | null;
    readonly #inFlight = new InFlightTracker();
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
        const route = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
            this.#inFlight.track(this.#route(req, res));
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
        await this.#inFlight.drain();
        this.#started = false;
        this.#stopping = false;
    }

    #resourceOrigin(req: RequestHeaders = { headers: {} }): string {
        return resolvePublicOrigin(req, this.#listener());
    }

    #corsHeaders(): Record<string, string> {
        return buildCorsHeaders(this.#opts.allowOrigin, {
            methods: "GET, HEAD, OPTIONS",
            allowHeaders: "authorization, accept",
        });
    }

    async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (this.#stopping) {
            writeHttpProblem(
                res,
                authProblem("service-stopping", 503, "The service is shutting down.", { stage: "shutdown", retryable: true }),
                this.#corsHeaders(),
            );
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
            writeHttpProblem(
                res,
                authProblem("route-not-found", 404, "The requested HTTP route does not exist.", { stage: "routing", retryable: false }),
                this.#corsHeaders(),
            );
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            writeHttpProblem(
                res,
                authProblem("method-not-allowed", 405, "Only GET, HEAD, and OPTIONS are supported on protected resource metadata.", { stage: "routing", retryable: false }),
                { ...this.#corsHeaders(), allow: "GET, HEAD, OPTIONS" },
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
