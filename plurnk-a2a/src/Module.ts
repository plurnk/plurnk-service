import {
    A2A_PROTOCOL_VERSION,
    AGENT_CARD_PATH,
    AgentCard,
} from "@a2a-js/sdk";
import type { User } from "@a2a-js/sdk/server";
import {
    UserBuilder,
    agentCardHandler,
    restHandler,
} from "@a2a-js/sdk/server/express";
import type { ApplicationPort, HttpHost } from "@plurnk/plurnk-contracts";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { HostedProposals } from "./config.ts";
import PlurnkAgentExecutor from "./PlurnkAgentExecutor.ts";
import PlurnkRequestHandler from "./PlurnkRequestHandler.ts";
import PlurnkTaskStore from "./PlurnkTaskStore.ts";
import WorkspaceBinding, { type A2aWorkspaceConfiguration } from "./WorkspaceBinding.ts";

export interface A2aModuleOptions {
    readonly workspace: A2aWorkspaceConfiguration;
    readonly card: AgentCard;
    readonly proposals: HostedProposals;
    /** The bearer the endpoint requires and the card declares; empty = an unauthenticated exposure. */
    readonly token: string;
    readonly endpointPath: string;
    /** Canonical public endpoint URL when it cannot be inferred from the service listener. */
    readonly endpointUrl?: string;
}

export interface A2aModuleRegistration {
    start(port: ApplicationPort): Promise<Module>;
}

// {§a2a-hosted-bearer} — the SDK's user for a caller that presented the configured bearer.
const BEARER_USER: User = { get isAuthenticated() { return true; }, get userName() { return "bearer"; } };

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

export default class Module {
    readonly #app: Express;
    readonly #card: AgentCard;
    readonly #endpointPath: string;
    readonly #endpointUrl: string | undefined;
    #closed = false;

    private constructor(application: ApplicationPort, options: A2aModuleOptions) {
        this.#endpointPath = options.endpointPath;
        this.#endpointUrl = options.endpointUrl;
        if (!this.#endpointPath.startsWith("/") || this.#endpointPath.includes("?") || this.#endpointPath.includes("#")) {
            throw new TypeError("A2A endpointPath must be an absolute URL pathname without query or fragment.");
        }
        if (options.card.securityRequirements.length > 0 || Object.keys(options.card.securitySchemes).length > 0) {
            throw new TypeError("The A2A card cannot declare security; the adapter declares the bearer scheme it enforces.");
        }
        const { token } = options;
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
        // {§a2a-hosted-bearer} — the card declares exactly what the endpoint enforces: one `http`
        // bearer scheme when a token is configured, none otherwise.
        this.#card.securitySchemes = token.length === 0 ? {} : {
            bearer: {
                scheme: {
                    $case: "httpAuthSecurityScheme",
                    value: { scheme: "bearer", bearerFormat: "", description: "The bearer configured for this exposure." },
                },
            },
        };
        this.#card.securityRequirements = token.length === 0 ? [] : [{ schemes: { bearer: { list: [] } } }];

        const workspace = new WorkspaceBinding(application, options.workspace);
        const store = new PlurnkTaskStore(application, workspace);
        const executor = new PlurnkAgentExecutor(application, workspace, store, options.proposals);
        const handler = new PlurnkRequestHandler(this.#card, store, executor);
        const app = express();
        // {§module-lifecycle} — close() stops accepting external work; the routes stay mounted on the
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
        app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => AgentCard.toJSON(this.#card) as AgentCard }));
        const endpoint = restHandler({
            requestHandler: handler,
            userBuilder: token.length === 0 ? UserBuilder.noAuthentication : async () => BEARER_USER,
        });
        if (token.length === 0) app.use(this.#endpointPath, endpoint);
        else app.use(this.#endpointPath, Module.#bearerGate(token), endpoint);
        this.#app = app;
    }

    static init(options: A2aModuleOptions): A2aModuleRegistration {
        return {
            start: async (application) => {
                const module = new Module(application, options);
                module.#mount(application);
                return module;
            },
        };
    }

    // {§a2a-hosted-bearer} — the perimeter: the exact bearer, checked before the SDK reads anything.
    // The card at the well-known path is not behind it, so a caller can discover the scheme.
    static #bearerGate(token: string) {
        return (req: Request, res: Response, next: NextFunction): void => {
            if (req.headers.authorization === `Bearer ${token}`) {
                next();
                return;
            }
            res.setHeader("www-authenticate", "Bearer");
            restError(res, 401, "UNAUTHENTICATED", "BEARER_TOKEN_REQUIRED", "The request did not provide the required bearer token.");
        };
    }

    // {§http-host} — the exposure rides the daemon's one listener: the public card at the standard
    // well-known path and the interface at its endpoint path, both on the service address.
    #mount(host: HttpHost): void {
        const address = host.httpAddress();
        this.#card.supportedInterfaces[0]!.url = this.#endpointUrl ?? `http://${address.host}:${address.port}${this.#endpointPath}`;
        host.registerHttpRoute(`/${AGENT_CARD_PATH}`, this.#app);
        host.registerHttpRoute(this.#endpointPath, this.#app);
    }

    agentCard(): AgentCard {
        return structuredClone(this.#card);
    }

    close(): void {
        this.#closed = true;
    }
}
