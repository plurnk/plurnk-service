import {
    A2A_PROTOCOL_VERSION,
    AGENT_CARD_PATH,
    AgentCard,
} from "@a2a-js/sdk";
import type { User } from "@a2a-js/sdk/server";
import type { IncomingMessage } from "node:http";
import {
    UserBuilder,
    agentCardHandler,
    restHandler,
} from "@a2a-js/sdk/server/express";
import { requestOrigin, type CredentialClaims } from "@plurnk/plurnk-contracts";
import type { ApplicationPort, HttpHost } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import TaskAdmission, { type AdmissionPort } from "./TaskAdmission.ts";
import PlurnkRequestHandler, { type RequestHandlerPort } from "./PlurnkRequestHandler.ts";
import HostedTasks, { type HostedTasksPort } from "./HostedTasks.ts";
import WorkspaceBinding, { type A2aWorkspaceConfiguration, type WorkspacePort } from "./WorkspaceBinding.ts";

export interface A2aExposureOptions {
    readonly workspace: A2aWorkspaceConfiguration;
    readonly card: AgentCard;
    readonly parentWorker: string;
    readonly endpointPath: string;
    /** Canonical public endpoint URL when it cannot be inferred from the service listener. */
    readonly endpointUrl?: string;
}

// {§a2a-inbound-exposure} The start seam: the port functions the exposure calls, the listener it mounts
// on, and the authority it admits through ({§a2a-hosted-credentials}).
export type ExposurePort = WorkspacePort & HostedTasksPort & AdmissionPort & RequestHandlerPort & HttpHost & Pick<ApplicationPort, "credentials">;

export interface A2aExposureRegistration extends DaemonModule<ModuleSetupSeam, ExposurePort> {
    readonly mounts: readonly string[];
    start(port: ExposurePort): Promise<Exposure>;
}

// {§a2a-hosted-credentials} — the one scope the exposure admits, and the SDK's user for an admitted caller:
// the credential's subject.
const A2A_SCOPE = "a2a";
const userOf = (claims: CredentialClaims): User => ({ get isAuthenticated() { return true; }, get userName() { return claims.subject; } });
type GatedRequest = Request & { plurnkClaims?: CredentialClaims };

// The REST binding's error body: google.rpc.Status carrying one ErrorInfo detail, the shape the SDK
// gives every other refusal on this interface.
const restError = (res: Response, code: number, status: string, reason: string, message: string): void => {
    res.status(code).json({
        error: {
            code,
            status,
            message,
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "plurnk.xyz" }],
        },
    });
};

export default class Exposure {
    readonly #app: Express;
    readonly #card: AgentCard;
    readonly #endpointPath: string;
    readonly #endpointUrl: string | undefined;
    readonly #handler: PlurnkRequestHandler;
    readonly #credentials: ApplicationPort["credentials"];
    readonly #listener: HttpHost["httpAddress"];
    #closed = false;

    private constructor(application: ExposurePort, options: A2aExposureOptions) {
        this.#endpointPath = options.endpointPath;
        this.#endpointUrl = options.endpointUrl;
        if (!this.#endpointPath.startsWith("/") || this.#endpointPath.includes("?") || this.#endpointPath.includes("#")) {
            throw new TypeError("A2A endpointPath must be an absolute URL pathname without query or fragment.");
        }
        if (options.card.securityRequirements.length > 0 || Object.keys(options.card.securitySchemes).length > 0) {
            throw new TypeError("The A2A card cannot declare security; the adapter declares the bearer scheme it enforces.");
        }
        this.#credentials = application.credentials;
        this.#listener = () => application.httpAddress();
        this.#card = structuredClone(options.card);
        this.#card.capabilities = {
            streaming: true,
            pushNotifications: false,
            extensions: options.card.capabilities?.extensions ?? [],
            extendedAgentCard: false,
        };
        this.#card.supportedInterfaces = [{
            url: options.endpointUrl ?? "",
            protocolBinding: "HTTP+JSON",
            protocolVersion: A2A_PROTOCOL_VERSION,
            tenant: "",
        }];
        const workspace = new WorkspaceBinding(application, options.workspace);
        const tasks = new HostedTasks(application, workspace);
        const admission = new TaskAdmission(application, workspace, tasks, options.parentWorker);
        this.#handler = new PlurnkRequestHandler(this.#card, tasks, admission, application);
        const app = express();
        // {§module-lifecycle} — stop() refuses new external work; the routes stay mounted on the
        // daemon's listener until the process ends, so they answer that the exposure is gone.
        app.use((_req: Request, res: Response, next: NextFunction) => {
            if (this.#closed) {
                restError(res, 503, "UNAVAILABLE", "EXPOSURE_CLOSED", "The A2A exposure has stopped accepting requests.");
                return;
            }
            next();
        });
        // The SDK writes the provided object verbatim, so the well-known route is handed the card's
        // proto3 JSON form: a declared security scheme is a oneof, and its TypeScript discriminator
        // (`$case`) is not wire format.
        // {§a2a-hosted-credentials} — the security section is the authority's posture at serve time, and
        // every address in it the one the asking request reached ({§http-request-origin}).
        app.use(`/${AGENT_CARD_PATH}`, (req: Request, res: Response, next: NextFunction) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SDK types its provider as the message and serializes the JSON form it is handed
            agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(this.agentCard(req)) as AgentCard })(req, res, next);
        });
        const endpoint = restHandler({
            requestHandler: this.#handler,
            userBuilder: async (req) => {
                const claims = (req as GatedRequest).plurnkClaims;
                return claims === undefined ? UserBuilder.noAuthentication() : userOf(claims);
            },
        });
        app.use(this.#endpointPath, this.#gate(), endpoint);
        this.#app = app;
    }

    static init(options: A2aExposureOptions): A2aExposureRegistration {
        return {
            // {§module-http-mounts} — the well-known card and the endpoint, claimed before setup.
            mounts: [`/${AGENT_CARD_PATH}`, options.endpointPath],
            start: async (application) => {
                const exposure = new Exposure(application, options);
                exposure.#mount(application);
                return exposure;
            },
        };
    }

    // {§a2a-hosted-credentials} — the perimeter: an access token of the daemon's authority carrying the
    // scope a2a, checked before the SDK reads anything, while the authority has a face. The card at
    // the well-known path is not behind it, so a caller can discover the scheme.
    #gate() {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (this.#credentials.face() === null) {
                next();
                return;
            }
            const header = req.headers.authorization;
            const presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
            if (presented === null) {
                res.setHeader("www-authenticate", 'Bearer realm="plurnk"');
                restError(res, 401, "UNAUTHENTICATED", "ACCESS_TOKEN_REQUIRED", "The request did not provide an access token.");
                return;
            }
            const claims = this.#credentials.verify((presented[1] ?? "").trim());
            if (claims === null || claims.kind !== "access") {
                res.setHeader("www-authenticate", 'Bearer realm="plurnk", error="invalid_token"');
                restError(res, 401, "UNAUTHENTICATED", "ACCESS_TOKEN_INVALID", "The access token is unknown, expired or revoked.");
                return;
            }
            if (!claims.scopes.includes(A2A_SCOPE)) {
                res.setHeader("www-authenticate", `Bearer realm="plurnk", error="insufficient_scope", scope="${A2A_SCOPE}"`);
                restError(res, 403, "PERMISSION_DENIED", "INSUFFICIENT_SCOPE", `The access token does not carry the scope ${A2A_SCOPE}.`);
                return;
            }
            (req as GatedRequest).plurnkClaims = claims;
            next();
        };
    }

    // {§http-host} — the exposure rides the daemon's one listener: the public card at the standard
    // well-known path and the interface at its endpoint path, both on the service address.
    #mount(host: HttpHost): void {
        host.registerHttpRoute(`/${AGENT_CARD_PATH}`, this.#app);
        host.registerHttpRoute(this.#endpointPath, this.#app);
    }

    // {§a2a-hosted-credentials} — the card declares exactly what the endpoint enforces: with a face, one
    // oauth2 scheme, client credentials at the daemon's own token endpoint with the scope a2a; none otherwise.
    agentCard(req: Pick<IncomingMessage, "headers">): AgentCard {
        const card = structuredClone(this.#card);
        card.supportedInterfaces[0].url = this.#endpointUrl ?? `${requestOrigin(req, this.#listener())}${this.#endpointPath}`;
        const face = this.#credentials.face();
        if (face === null) {
            card.securitySchemes = {};
            card.securityRequirements = [];
            return card;
        }
        const issuer = face.issuer(req);
        card.securitySchemes = {
            oauth2: {
                scheme: {
                    $case: "oauth2SecurityScheme",
                    value: {
                        description: "The daemon's credential authority: client credentials for a declared client.",
                        flows: { flow: { $case: "clientCredentials", value: { tokenUrl: `${issuer}/oauth/token`, refreshUrl: "", scopes: { [A2A_SCOPE]: "Send Tasks to this agent." } } } },
                        oauth2MetadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
                    },
                },
            },
        };
        card.securityRequirements = [{ schemes: { oauth2: { list: [A2A_SCOPE] } } }];
        return card;
    }

    stop(): void {
        this.#closed = true;
    }

    async close(): Promise<void> {
        await this.#handler.close();
    }
}
