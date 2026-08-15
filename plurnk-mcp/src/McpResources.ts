import {
    Results,
    type EntryAddress,
    type EntryData,
    type EntryFindResult,
    type EntryStorageReadResult,
    type FindStatement,
    type ParsedPath,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type SchemeCtx,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import { renderJsonResult } from "@plurnk/plurnk-execs";
import type { ReadResourceResult, Tool } from "@modelcontextprotocol/client";
import ServerConnection from "./client.ts";
import ToolAddress from "./ToolAddress.ts";

const ROOT = "/";
const RESOURCES = "/resources";
const RESOURCE_PREFIX = `${RESOURCES}/`;
const TOOLS = "/tools";
const RESOURCE_KIND = "mcp-resource";
const CATALOG_KIND = "mcp-resource-catalog";
const TOOL_KIND = "mcp-tool-contract";
const TOOL_PATHS = "toolPaths";

class AddressError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, status: number, message: string, options?: ErrorOptions) {
        super(message, options);
        this.code = code;
        this.status = status;
    }
}

class EntryOperationFailure extends Error {
    readonly result: SchemeResult;

    constructor(result: SchemeResult) {
        super(result.problem?.detail ?? `Entry operation failed with status ${result.status}.`, {
            cause: result.problem,
        });
        this.result = result;
    }
}

const requireEntrySuccess = <T extends SchemeResult>(
    result: T,
): T => {
    const exact = Results.assert(result);
    if (Results.isErrorStatus(exact.status)) throw new EntryOperationFailure(exact);
    return exact;
};

const resourcePath = (uri: string): string =>
    `${RESOURCE_PREFIX}${encodeURIComponent(uri)}`;

const preparationFailure = (
    server: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>>,
): RepresentationPreparationResult => Results.failure(
    "scheme:mcp",
    code,
    status,
    detail,
    {},
    {
        server,
        stage: "mcp-resource",
        ...extensions,
    },
) as RepresentationPreparationResult;

const findFailure = (
    server: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>>,
): EntryFindResult => Results.failure(
    "scheme:mcp",
    code,
    status,
    detail,
    {
        content: null,
        mimetype: null,
        results: [],
        itemsWeightTotal: 0,
        returnedItemsWeightTotal: 0,
        matchingPathCount: 0,
        matchLocationCount: 0,
    },
    {
        server,
        stage: "mcp-resource",
        ...extensions,
    },
) as EntryFindResult;

const preparationEntryFailure = (
    failure: EntryOperationFailure,
): RepresentationPreparationResult => Results.assertRepresentationPreparation({
    status: failure.result.status,
    problem: failure.result.problem,
});

const findEntryFailure = (
    failure: EntryOperationFailure,
): EntryFindResult => Results.assert({
    status: failure.result.status,
    problem: failure.result.problem,
    content: null,
    mimetype: null,
    results: [],
    itemsWeightTotal: 0,
    returnedItemsWeightTotal: 0,
    matchingPathCount: 0,
    matchLocationCount: 0,
});

const resourceBody = (result: ReadResourceResult): {
    content: string;
    mimetype: string;
} => {
    if (result.contents.length === 1 && "text" in result.contents[0]!) {
        const value = result.contents[0]!;
        return {
            content: value.text,
            mimetype: value.mimeType ?? "text/plain",
        };
    }
    return {
        content: JSON.stringify(result),
        mimetype: "application/json",
    };
};

const catalogEntry = (
    content: string,
    kind: string,
    attributes: Readonly<Record<string, unknown>> = {},
): EntryData => ({
    channels: {
        body: {
            content,
            mimetype: "application/json",
        },
    },
    attributes: { kind, ...attributes },
});

const priorToolPaths = (entry: EntryStorageReadResult["entry"]): string[] => {
    if (entry?.attributes?.kind !== "mcp-tool-index") return [];
    const value = entry.attributes[TOOL_PATHS];
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new TypeError("Stored MCP catalog toolPaths metadata is malformed.");
    }
    for (const pathname of value) {
        const encoded = pathname.startsWith("/tools/") ? pathname.slice("/tools/".length) : "";
        let name: string;
        try {
            name = decodeURIComponent(encoded);
        } catch (cause) {
            throw new TypeError(`Stored MCP tool path '${pathname}' is malformed.`, { cause });
        }
        if (encoded.length === 0 || ToolAddress.internalPath(name) !== pathname) {
            throw new TypeError(`Stored MCP tool path '${pathname}' is non-canonical.`);
        }
    }
    return value;
};

export default class McpResources {
    readonly #server: string;
    readonly #connection: ServerConnection;

    constructor(server: string, connection: ServerConnection) {
        this.#server = server;
        this.#connection = connection;
    }

    claims(target: ParsedPath): boolean {
        if (target.kind !== "url" || target.scheme !== this.#server) return false;
        if (target.hostname !== null) return target.pathname === ROOT;
        return target.pathname === ROOT
            || target.pathname === RESOURCES
            || target.pathname.startsWith(RESOURCE_PREFIX);
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: SchemeCtx,
    ): Promise<EntryAddress | SchemeResult | null> {
        if (!this.claims(target) || target.kind !== "url") return null;
        if (
            target.username !== null
            || target.password !== null
            || target.port !== null
            || target.query !== null
            || target.headers !== undefined
        ) {
            return Results.failure(
                "scheme:mcp",
                "address-invalid",
                400,
                `MCP address '${target.raw}' contains unsupported authority or request metadata.`,
                {},
                { server: this.#server, stage: "mcp-resource", retryable: false },
            );
        }
        if (ToolAddress.isCatalog(target)) {
            return Results.failure(
                "scheme:mcp",
                "tool-catalog-not-resource",
                400,
                `MCP tool catalog '${this.#server}://*/' is a FIND scope, not one readable resource.`,
                {},
                {
                    server: this.#server,
                    stage: "mcp-resource",
                    recovery: `Use FIND (${this.#server}://*/).`,
                    retryable: false,
                },
            );
        }
        const tool = ToolAddress.name(target);
        if (target.hostname !== null) {
            if (tool === null) {
                return Results.failure(
                    "scheme:mcp",
                    "tool-address-invalid",
                    400,
                    `MCP tool address '${target.raw}' is invalid.`,
                    {},
                    { server: this.#server, stage: "mcp-resource", retryable: false },
                );
            }
            return { pathname: ToolAddress.internalPath(tool), owner: "commons" };
        }
        return { pathname: target.pathname, owner: "commons" };
    }

    async #materializeTools(
        source: readonly Tool[],
        ctx: SchemeCtx,
    ): Promise<ReadonlySet<string>> {
        const tools = source.map((tool) => ({
            ...tool,
            address: ToolAddress.render(this.#server, tool.name),
        }));
        const currentToolPaths = tools.map((tool) => ToolAddress.internalPath(tool.name));
        const previous = requireEntrySuccess(await ctx.entries.read(TOOLS));

        await Promise.all(tools.map(async (tool) => {
            requireEntrySuccess(await ctx.entries.write(
                ToolAddress.internalPath(tool.name),
                catalogEntry(JSON.stringify(tool), TOOL_KIND),
            ));
        }));

        const previousToolPaths = priorToolPaths(previous.entry);
        const current = new Set(currentToolPaths);
        await Promise.all(previousToolPaths
            .filter((pathname) => !current.has(pathname))
            .map(async (pathname) => {
                const deleted = Results.assert(await ctx.entries.delete(pathname));
                if (Results.isErrorStatus(deleted.status) && deleted.status !== 404) {
                    throw new EntryOperationFailure(deleted);
                }
            }));

        requireEntrySuccess(await ctx.entries.write(
            TOOLS,
            catalogEntry(JSON.stringify({ tools }), "mcp-tool-index", {
                [TOOL_PATHS]: currentToolPaths,
            }),
        ));
        return new Set(source.map((tool) => tool.name));
    }

    async #materializeCatalog(ctx: SchemeCtx): Promise<void> {
        const catalog = await this.#connection.catalog(ctx.signal);
        const tools = catalog.tools.map((tool) => ({
            ...tool,
            address: ToolAddress.render(this.#server, tool.name),
        }));
        const resources = catalog.resources.map((resource) => ({
            ...resource,
            address: `${this.#server}://${resourcePath(resource.uri)}`,
        }));
        await this.#materializeTools(catalog.tools, ctx);
        await Promise.all(catalog.resources.map(async (resource) => {
            const pathname = resourcePath(resource.uri);
            const existing = requireEntrySuccess(await ctx.entries.read(pathname));
            if (existing.entry?.attributes?.kind === RESOURCE_KIND) return;
            requireEntrySuccess(await ctx.entries.write(
                pathname,
                catalogEntry(
                    JSON.stringify({
                        ...resource,
                        address: `${this.#server}://${pathname}`,
                    }),
                    CATALOG_KIND,
                ),
            ));
        }));

        requireEntrySuccess(await ctx.entries.write(
            RESOURCES,
            catalogEntry(JSON.stringify({
                resources,
                resourceTemplates: catalog.resourceTemplates,
            }), "mcp-resource-index"),
        ));
        requireEntrySuccess(await ctx.entries.write(
            ROOT,
            catalogEntry(JSON.stringify({
                ...catalog,
                tools,
                resources,
            }), "mcp-catalog"),
        ));
    }

    async #materializeResource(pathname: string, ctx: SchemeCtx): Promise<void> {
        const encoded = pathname.slice(RESOURCE_PREFIX.length);
        if (encoded.length === 0 || encoded.includes("/")) {
            throw new AddressError(
                "resource-address-invalid",
                400,
                `Invalid MCP resource address '${pathname}'.`,
            );
        }
        let uri: string;
        try {
            uri = decodeURIComponent(encoded);
        } catch (cause) {
            throw new AddressError(
                "resource-address-invalid",
                400,
                `Invalid encoded MCP resource address '${pathname}'.`,
                { cause },
            );
        }
        const body = resourceBody(await this.#connection.readResource(uri, ctx.signal));
        requireEntrySuccess(await ctx.entries.write(pathname, {
            channels: {
                body: {
                    content: body.content,
                    mimetype: body.mimetype,
                },
            },
            attributes: { kind: RESOURCE_KIND },
        }));
    }

    #mappedToolStatement(statement: FindStatement): FindStatement {
        const target = statement.target;
        if (target?.kind !== "url" || target.hostname === null) return statement;
        const name = ToolAddress.name(target);
        const pathname = ToolAddress.isCatalog(target)
            ? "/tools/*"
            : name === null
                ? null
                : ToolAddress.internalPath(name);
        if (pathname === null) {
            throw new AddressError(
                "tool-address-invalid",
                400,
                `Invalid MCP tool address '${target.raw}'.`,
            );
        }
        return {
            ...statement,
            target: {
                ...target,
                raw: `${this.#server}://${pathname}`,
                hostname: null,
                pathname,
            },
        };
    }

    #publicToolPath(path: string): string {
        const prefix = `${this.#server}:///tools/`;
        if (!path.startsWith(prefix)) return path;
        const suffix = path.slice(prefix.length);
        const fragment = suffix.indexOf("#");
        const authority = fragment === -1 ? suffix : suffix.slice(0, fragment);
        const channel = fragment === -1 ? "" : suffix.slice(fragment);
        return `${this.#server}://${authority}/${channel}`;
    }

    #readdress(value: unknown): unknown {
        if (Array.isArray(value)) return value.map((item) => this.#readdress(item));
        if (typeof value !== "object" || value === null) return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            key === "path" && typeof item === "string"
                ? this.#publicToolPath(item)
                : this.#readdress(item),
        ]));
    }

    #publicFindResult(result: EntryFindResult): EntryFindResult {
        const results = this.#readdress(result.results) as EntryFindResult["results"];
        const content = result.content === null
            ? null
            : renderJsonResult(this.#readdress(JSON.parse(result.content)));
        return { ...result, results, content };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        try {
            const target = request.target;
            if (target.kind === "url" && target.hostname !== null) {
                if (ToolAddress.isCatalog(target)) {
                    throw new AddressError(
                        "tool-catalog-not-resource",
                        400,
                        `MCP tool catalog '${this.#server}://*/' is a FIND scope, not one readable resource.`,
                    );
                }
                const tool = ToolAddress.name(target);
                if (tool === null) {
                    throw new AddressError(
                        "tool-address-invalid",
                        400,
                        `Invalid MCP tool address '${target.raw}'.`,
                    );
                }
                const tools = await this.#materializeTools(
                    await this.#connection.tools(ctx.signal),
                    ctx,
                );
                if (!tools.has(tool)) {
                    throw new AddressError(
                        "tool-not-found",
                        404,
                        `MCP server '${this.#server}' exposes no tool named '${tool}'.`,
                    );
                }
                return { status: 200 };
            }
            const pathname = request.pathname;
            const exactResource = pathname.startsWith(RESOURCE_PREFIX)
                && !/[*?[\]{}]/.test(pathname);
            if (exactResource) {
                await this.#materializeResource(pathname, ctx);
            } else {
                await this.#materializeCatalog(ctx);
            }
            return { status: 200 };
        } catch (error) {
            if (error instanceof EntryOperationFailure) {
                return preparationEntryFailure(error);
            }
            const addressError = error instanceof AddressError;
            return preparationFailure(
                this.#server,
                addressError ? error.code : "resource-read-failed",
                addressError ? error.status : 502,
                addressError
                    ? error.message
                    : `MCP server '${this.#server}' could not materialize the requested representation.`,
                {
                    diagnostic: error instanceof Error ? error.message : String(error),
                    retryable: !addressError,
                },
            );
        }
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        try {
            const target = statement.target;
            if (target?.kind === "url" && target.hostname !== null) {
                const exact = ToolAddress.name(target);
                const tools = await this.#materializeTools(
                    await this.#connection.tools(ctx.signal),
                    ctx,
                );
                if (!ToolAddress.isCatalog(target) && exact !== null && !tools.has(exact)) {
                    throw new AddressError(
                        "tool-not-found",
                        404,
                        `MCP server '${this.#server}' exposes no tool named '${exact}'.`,
                    );
                }
            } else {
                await this.#materializeCatalog(ctx);
            }
            const result = await ctx.entries.operations.find(
                this.#mappedToolStatement(statement),
                "commons",
            );
            return this.#publicFindResult(result);
        } catch (error) {
            if (error instanceof EntryOperationFailure) return findEntryFailure(error);
            if (error instanceof AddressError) {
                return findFailure(
                    this.#server,
                    error.code,
                    error.status,
                    error.message,
                    { retryable: false },
                );
            }
            return findFailure(
                this.#server,
                "catalog-find-failed",
                502,
                `MCP server '${this.#server}' could not search its catalog.`,
                {
                    diagnostic: error instanceof Error ? error.message : String(error),
                    retryable: true,
                },
            );
        }
    }
}
