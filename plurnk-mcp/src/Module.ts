import type {
    RuntimeAvailability,
    RuntimeDecl,
} from "@plurnk/plurnk-execs";
import type {
    FindStatement,
    ReadStatement,
    SchemeCtx,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import ServerConnection from "./client.ts";
import { serverConfig, serverNames } from "./config.ts";
import McpExecutor, { runtimeDecl } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";

interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

interface ModuleSetupSeam {
    registerRuntime(registration: {
        readonly namespaceOwner: string;
        readonly decl: RuntimeDecl;
        readonly executor: McpExecutor;
        readonly availability: RuntimeAvailability;
        readonly scheme?: RuntimeSchemeFacet;
    }): Promise<void>;
}

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

export default class Module {
    readonly #env: NodeJS.ProcessEnv;
    readonly #connections = new Map<string, ServerConnection>();

    static init(options: ModuleOptions = {}): Module {
        return new Module(options.env ?? process.env);
    }

    private constructor(environ: NodeJS.ProcessEnv) {
        this.#env = environ;
    }

    async setup(seam: ModuleSetupSeam): Promise<void> {
        const results = await Promise.allSettled(
            serverNames(this.#env).map(async (name) => {
                const config = serverConfig(name, this.#env);
                if (config === null) throw new Error(`MCP server '${name}' disappeared during configuration.`);
                const connection = new ServerConnection(config, this.#env);
                this.#connections.set(name, connection);
                const decl = runtimeDecl(name);
                const executor = new McpExecutor(
                    {
                        runtime: name,
                        glyph: decl.glyph ?? "",
                    },
                    connection,
                );
                return {
                    namespaceOwner: "@plurnk/plurnk-mcp",
                    decl,
                    executor,
                    availability: await executor.probe(),
                    scheme: new McpResources(name, connection),
                };
            }),
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "MCP module setup failed");
        const registrations = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : []);
        for (const registration of registrations) {
            await seam.registerRuntime(registration);
        }
    }

    async close(): Promise<void> {
        const connections = [...this.#connections.values()];
        this.#connections.clear();
        const results = await Promise.allSettled(
            connections.map((connection) => connection.close()),
        );
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "MCP connection shutdown failed");
    }
}
