import { createServer, type Server } from "node:http";
import {
    A2A_PROTOCOL_VERSION,
    AGENT_CARD_PATH,
    type AgentCard,
} from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import {
    UserBuilder,
    agentCardHandler,
    restHandler,
} from "@a2a-js/sdk/server/express";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import express from "express";
import PlurnkAgentExecutor from "./PlurnkAgentExecutor.ts";
import PlurnkTaskStore from "./PlurnkTaskStore.ts";
import WorkspaceBinding, { type A2aWorkspaceConfiguration } from "./WorkspaceBinding.ts";

export interface A2aModuleOptions {
    readonly workspace: A2aWorkspaceConfiguration;
    readonly card: AgentCard;
    readonly host?: string;
    readonly port?: number;
    readonly endpointPath?: string;
    /** Canonical public endpoint URL when it cannot be inferred from the listener. */
    readonly endpointUrl?: string;
}

export interface A2aModuleRegistration {
    start(port: ApplicationPort): Promise<Module>;
}

const listen = (server: Server, port: number, host: string): Promise<void> =>
    new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });

const close = (server: Server): Promise<void> =>
    new Promise((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });

export default class Module {
    readonly #server: Server;
    readonly #host: string;
    readonly #card: AgentCard;
    readonly #endpointPath: string;
    readonly #endpointUrl: string | undefined;
    readonly #port: number;

    private constructor(application: ApplicationPort, options: A2aModuleOptions) {
        this.#host = options.host ?? "127.0.0.1";
        this.#port = options.port ?? 0;
        this.#endpointPath = options.endpointPath ?? "/a2a";
        this.#endpointUrl = options.endpointUrl;
        if (!this.#endpointPath.startsWith("/") || this.#endpointPath.includes("?") || this.#endpointPath.includes("#")) {
            throw new TypeError("A2A endpointPath must be an absolute URL pathname without query or fragment.");
        }
        if (options.card.securityRequirements.length > 0 || Object.keys(options.card.securitySchemes).length > 0) {
            throw new TypeError("An unauthenticated A2A listener cannot advertise security requirements or schemes.");
        }
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
        const store = new PlurnkTaskStore(application, workspace);
        const executor = new PlurnkAgentExecutor(application, workspace, store);
        const handler = new DefaultRequestHandler(this.#card, store, executor);
        const app = express();
        app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
        app.use(this.#endpointPath, restHandler({
            requestHandler: handler,
            userBuilder: UserBuilder.noAuthentication,
        }));
        this.#server = createServer(app);
    }

    static init(options: A2aModuleOptions): A2aModuleRegistration {
        return {
            start: async (application) => {
                const module = new Module(application, options);
                await module.listen();
                return module;
            },
        };
    }

    async listen(): Promise<{ host: string; port: number; endpoint: string }> {
        await listen(this.#server, this.#port, this.#host);
        const address = this.address();
        const endpoint = this.#endpointUrl ?? `http://${address.host}:${address.port}${this.#endpointPath}`;
        this.#card.supportedInterfaces[0]!.url = endpoint;
        return { ...address, endpoint };
    }

    address(): { host: string; port: number } {
        const address = this.#server.address();
        if (address === null || typeof address === "string") throw new Error("plurnk-a2a: listener is not active");
        return { host: this.#host, port: address.port };
    }

    agentCard(): AgentCard {
        return structuredClone(this.#card);
    }

    close(): Promise<void> {
        return close(this.#server);
    }
}
