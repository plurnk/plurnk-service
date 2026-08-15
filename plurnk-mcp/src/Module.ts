import type {
    RuntimeAvailability,
    RuntimeDecl,
} from "@plurnk/plurnk-execs";
import type {
    FindStatement,
    EntryAddress,
    ParsedPath,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import ServerConnection from "./client.ts";
import { serverConfig, serverNames } from "./config.ts";
import McpExecutor, { runtimeDecl } from "./McpExecutor.ts";
import McpResources from "./McpResources.ts";

interface RuntimeSchemeFacet {
    claims(target: ParsedPath): boolean;
    resolveEntryAddress?(
        target: ParsedPath,
        ctx: SchemeCtx,
    ): Promise<EntryAddress | SchemeResult | null>;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

interface ModuleSetupSeam {
    registerRuntimes(registrations: readonly {
        readonly namespaceOwner: string;
        readonly decl: RuntimeDecl;
        readonly executor: McpExecutor;
        readonly availability: RuntimeAvailability;
        readonly scheme?: RuntimeSchemeFacet;
    }[]): Promise<void>;
}

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
}

interface ClosableConnection {
    close(): Promise<void>;
}

const errorsOf = (error: unknown): unknown[] =>
    error instanceof AggregateError ? [...error.errors] : [error];

const throwFailures = (errors: readonly unknown[], message: string): void => {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
};

export const closeConnections = async (
    connections: readonly ClosableConnection[],
): Promise<void> => {
    const results = await Promise.allSettled(
        connections.map((connection) => connection.close()),
    );
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .flatMap((result) => errorsOf(result.reason));
    if (errors.length > 0) {
        throw new AggregateError(errors, "MCP connection shutdown failed");
    }
};

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
        try {
            const configured = serverNames(this.#env).map((name) => {
                const config = serverConfig(name, this.#env);
                if (config === null) throw new Error(`MCP server '${name}' disappeared during configuration.`);
                return { name, config };
            });
            const candidates = configured.map(({ name, config }) => {
                const connection = new ServerConnection(config, this.#env);
                this.#connections.set(name, connection);
                const decl = runtimeDecl(name);
                const executor = new McpExecutor(
                    {
                        runtime: name,
                        glyph: decl.glyph ?? "",
                    },
                    connection,
                    {
                        featured: config.featured ?? false,
                        read: config.read ?? [],
                    },
                );
                return {
                    name,
                    namespaceOwner: "@plurnk/plurnk-mcp",
                    decl,
                    executor,
                    scheme: new McpResources(name, connection),
                };
            });
            const results = await Promise.allSettled(candidates.map(async (candidate) => {
                try {
                    return {
                        ...candidate,
                        availability: await candidate.executor.requireAvailable(),
                    };
                } catch (cause) {
                    throw new Error(`Configured MCP server '${candidate.name}' is unavailable.`, { cause });
                }
            }));
            const errors = results
                .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                .map((result) => result.reason);
            throwFailures(errors, "MCP module setup failed");
            const registrations = results.flatMap((result) =>
                result.status === "fulfilled"
                    ? [{
                        namespaceOwner: result.value.namespaceOwner,
                        decl: result.value.decl,
                        executor: result.value.executor,
                        availability: result.value.availability,
                        scheme: result.value.scheme,
                    }]
                    : []);
            if (registrations.length > 0) await seam.registerRuntimes(registrations);
        } catch (cause) {
            try {
                await this.close();
            } catch (closeCause) {
                throw new AggregateError(
                    [...errorsOf(cause), ...errorsOf(closeCause)],
                    "MCP module setup and rollback failed",
                );
            }
            throw cause;
        }
    }

    async close(): Promise<void> {
        const connections = [...this.#connections.values()];
        this.#connections.clear();
        await closeConnections(connections);
    }
}
