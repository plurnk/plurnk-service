import {
    Client,
    StreamableHTTPClientTransport,
    type CallToolResult,
    type DiscoverResult,
    type ReadResourceResult,
    type Tool,
} from "@modelcontextprotocol/client";
import {
    StdioClientTransport,
    getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import packageJson from "../package.json" with { type: "json" };
import {
    connectTimeoutMs,
    requestTimeoutMs,
    type ServerConfig,
} from "./config.ts";
import { MCP_PROTOCOL_VERSION } from "./protocol.ts";

export interface ServerCatalog {
    readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
    readonly server: ReturnType<Client["getServerVersion"]>;
    readonly capabilities: DiscoverResult["capabilities"];
    readonly tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    readonly resources: Awaited<ReturnType<Client["listResources"]>>["resources"];
    readonly resourceTemplates: Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"];
    readonly prompts: Awaited<ReturnType<Client["listPrompts"]>>["prompts"];
}

const openTransport = (config: ServerConfig): StdioClientTransport | StreamableHTTPClientTransport => {
    if (config.transport === "http") {
        return new StreamableHTTPClientTransport(
            new URL(config.url),
            config.headers === undefined
                ? undefined
                : { requestInit: { headers: config.headers } },
        );
    }
    return new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: {
            ...getDefaultEnvironment(),
            ...config.env,
        },
    });
};

const openClient = async (
    config: ServerConfig,
    environ: NodeJS.ProcessEnv,
): Promise<Client> => {
    const client = new Client(
        {
            name: packageJson.name,
            version: packageJson.version,
        },
        {
            versionNegotiation: {
                mode: { pin: MCP_PROTOCOL_VERSION },
            },
            inputRequired: {
                autoFulfill: false,
            },
        },
    );
    try {
        await client.connect(openTransport(config), {
            timeout: connectTimeoutMs(environ),
        });
    } catch (cause) {
        try {
            await client.close();
        } catch (closeCause) {
            throw new AggregateError(
                [cause, closeCause],
                `MCP ${MCP_PROTOCOL_VERSION} connection and cleanup failed.`,
            );
        }
        throw new Error(`MCP ${MCP_PROTOCOL_VERSION} connection failed.`, { cause });
    }
    if (
        client.getProtocolEra() !== "modern"
        || client.getNegotiatedProtocolVersion() !== MCP_PROTOCOL_VERSION
        || client.getDiscoverResult() === undefined
    ) {
        await client.close();
        throw new Error(`MCP server did not negotiate required revision ${MCP_PROTOCOL_VERSION}.`);
    }
    return client;
};

export default class ServerConnection {
    readonly #config: ServerConfig;
    readonly #environ: NodeJS.ProcessEnv;
    #client: Promise<Client> | undefined;

    constructor(config: ServerConfig, environ: NodeJS.ProcessEnv = process.env) {
        this.#config = config;
        this.#environ = environ;
    }

    connect(): Promise<Client> {
        if (this.#client !== undefined) return this.#client;
        const pending = openClient(this.#config, this.#environ).catch((cause: unknown) => {
            if (this.#client === pending) this.#client = undefined;
            throw cause;
        });
        this.#client = pending;
        return pending;
    }

    async tools(signal?: AbortSignal): Promise<Tool[]> {
        const client = await this.connect();
        const { tools } = await client.listTools(undefined, this.#requestOptions(signal));
        return tools;
    }

    async catalog(signal?: AbortSignal): Promise<ServerCatalog> {
        const client = await this.connect();
        const discover = client.getDiscoverResult();
        if (discover === undefined) throw new Error("Modern MCP connection omitted its discovery result.");
        const [tools, resources, resourceTemplates, prompts] = await Promise.all([
            discover.capabilities.tools === undefined
                ? Promise.resolve([])
                : this.tools(signal),
            discover.capabilities.resources === undefined
                ? Promise.resolve([])
                : client.listResources(undefined, this.#requestOptions(signal)).then((result) => result.resources),
            discover.capabilities.resources === undefined
                ? Promise.resolve([])
                : client.listResourceTemplates(undefined, this.#requestOptions(signal)).then((result) => result.resourceTemplates),
            discover.capabilities.prompts === undefined
                ? Promise.resolve([])
                : client.listPrompts(undefined, this.#requestOptions(signal)).then((result) => result.prompts),
        ]);
        return {
            protocolVersion: MCP_PROTOCOL_VERSION,
            server: client.getServerVersion(),
            capabilities: discover.capabilities,
            tools,
            resources,
            resourceTemplates,
            prompts,
        };
    }

    async resources(signal?: AbortSignal): Promise<{
        resources: ServerCatalog["resources"];
        resourceTemplates: ServerCatalog["resourceTemplates"];
    }> {
        const client = await this.connect();
        const discover = client.getDiscoverResult();
        if (discover?.capabilities.resources === undefined) {
            return {
                resources: [],
                resourceTemplates: [],
            };
        }
        const [resources, resourceTemplates] = await Promise.all([
            client.listResources(undefined, this.#requestOptions(signal))
                .then((result) => result.resources),
            client.listResourceTemplates(undefined, this.#requestOptions(signal))
                .then((result) => result.resourceTemplates),
        ]);
        return {
            resources,
            resourceTemplates,
        };
    }

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
        return (await this.connect()).callTool(
            { name, arguments: args },
            this.#requestOptions(signal),
        );
    }

    async readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
        return (await this.connect()).readResource(
            { uri },
            this.#requestOptions(signal),
        );
    }

    #requestOptions(signal?: AbortSignal): { signal?: AbortSignal; timeout: number } {
        return {
            signal,
            timeout: requestTimeoutMs(this.#environ),
        };
    }

    async close(): Promise<void> {
        const client = this.#client;
        this.#client = undefined;
        if (client !== undefined) await (await client).close();
    }
}
