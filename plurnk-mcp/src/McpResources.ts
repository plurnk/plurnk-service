import {
    Results,
    type EntryData,
    type EntryFindResult,
    type FindStatement,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type SchemeCtx,
} from "@plurnk/plurnk-schemes";
import type { ReadResourceResult } from "@modelcontextprotocol/client";
import ServerConnection from "./client.ts";

const ROOT = "/";
const RESOURCES = "/resources";
const RESOURCE_PREFIX = `${RESOURCES}/`;
const RESOURCE_TAG = "mcp-resource";
const CATALOG_TAG = "mcp-resource-catalog";

class ResourceAddressError extends Error {}

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
        itemsTokenTotal: 0,
        returnedItemsTokenTotal: 0,
        matchingPathCount: 0,
        matchLocationCount: 0,
    },
    {
        server,
        stage: "mcp-resource",
        ...extensions,
    },
) as EntryFindResult;

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

const catalogEntry = (content: string, tags: string[]): EntryData => ({
    channels: {
        body: {
            content,
            mimetype: "application/json",
        },
    },
    tags,
});

export default class McpResources {
    readonly #server: string;
    readonly #connection: ServerConnection;

    constructor(server: string, connection: ServerConnection) {
        this.#server = server;
        this.#connection = connection;
    }

    claims(pathname: string): boolean {
        return pathname === ROOT
            || pathname === RESOURCES
            || pathname.startsWith(RESOURCE_PREFIX);
    }

    async #materializeCatalog(ctx: SchemeCtx): Promise<void> {
        const catalog = await this.#connection.catalog(ctx.signal);
        await ctx.entries.write(
            ROOT,
            catalogEntry(JSON.stringify({
                ...catalog,
                resources: catalog.resources.map((resource) => ({
                    ...resource,
                    address: `${this.#server}://${resourcePath(resource.uri)}`,
                })),
            }), ["mcp-catalog"]),
        );
        await ctx.entries.write(
            RESOURCES,
            catalogEntry(JSON.stringify({
                resources: catalog.resources.map((resource) => ({
                    ...resource,
                    address: `${this.#server}://${resourcePath(resource.uri)}`,
                })),
                resourceTemplates: catalog.resourceTemplates,
            }), ["mcp-resource-index"]),
        );
        await Promise.all(catalog.resources.map(async (resource) => {
            const pathname = resourcePath(resource.uri);
            const existing = await ctx.entries.read(pathname);
            if (existing.entry?.tags.includes(RESOURCE_TAG) === true) return;
            await ctx.entries.write(
                pathname,
                catalogEntry(
                    JSON.stringify({
                        ...resource,
                        address: `${this.#server}://${pathname}`,
                    }),
                    [CATALOG_TAG],
                ),
            );
        }));
    }

    async #materializeResource(pathname: string, ctx: SchemeCtx): Promise<void> {
        const encoded = pathname.slice(RESOURCE_PREFIX.length);
        if (encoded.length === 0 || encoded.includes("/")) {
            throw new ResourceAddressError(`Invalid MCP resource address '${pathname}'.`);
        }
        let uri: string;
        try {
            uri = decodeURIComponent(encoded);
        } catch (cause) {
            throw new ResourceAddressError(`Invalid encoded MCP resource address '${pathname}'.`, { cause });
        }
        const body = resourceBody(await this.#connection.readResource(uri, ctx.signal));
        await ctx.entries.write(pathname, {
            channels: {
                body: {
                    content: body.content,
                    mimetype: body.mimetype,
                },
            },
            tags: [RESOURCE_TAG],
        });
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const pathname = request.pathname;
        try {
            const exactResource = pathname.startsWith(RESOURCE_PREFIX)
                && !/[*?[\]{}]/.test(pathname);
            if (exactResource) {
                await this.#materializeResource(pathname, ctx);
            } else {
                await this.#materializeCatalog(ctx);
            }
            return { status: 200 };
        } catch (error) {
            const invalidAddress = error instanceof ResourceAddressError;
            return preparationFailure(
                this.#server,
                invalidAddress ? "resource-address-invalid" : "resource-read-failed",
                invalidAddress ? 400 : 502,
                invalidAddress
                    ? `The requested MCP resource address for '${this.#server}' is invalid.`
                    : `MCP server '${this.#server}' could not read the requested resource.`,
                {
                    diagnostic: error instanceof Error ? error.message : String(error),
                    retryable: !invalidAddress,
                },
            );
        }
    }

    async find(statement: FindStatement, ctx: SchemeCtx): Promise<EntryFindResult> {
        try {
            await this.#materializeCatalog(ctx);
            return await ctx.entries.operations.find(statement);
        } catch (error) {
            return findFailure(
                this.#server,
                "resource-find-failed",
                502,
                `MCP server '${this.#server}' could not list its resources.`,
                {
                    diagnostic: error instanceof Error ? error.message : String(error),
                    retryable: true,
                },
            );
        }
    }
}
