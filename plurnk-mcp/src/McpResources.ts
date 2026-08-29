import {
    Results,
    type EntryData,
    type EntryFindResult,
    type EntryStorageReadResult,
    type EntryStorageWriteResult,
    type FindStatement,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type SchemeCtx,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import { ErrorDetail, ERROR_DETAIL_LIMIT } from "@plurnk/plurnk-execs";
import type { ReadResourceResult } from "@modelcontextprotocol/client";
import ServerConnection, { type ServerCatalog } from "./client.ts";

const ROOT = "/";
const RESOURCES = "/resources";
const RESOURCE_PREFIX = `${RESOURCES}/`;
const PROMPTS = "/prompts";
const PROMPT_PREFIX = `${PROMPTS}/`;
const RESOURCE_KIND = "mcp-resource";
const CATALOG_KIND = "mcp-resource-catalog";
const PROMPT_KIND = "mcp-prompt";

const diagnostic = (error: unknown): string => {
    const limit = ErrorDetail.configuredLimit();
    if (limit === null) throw new Error(`${ERROR_DETAIL_LIMIT} must be set to a non-negative integer.`);
    return ErrorDetail.preview(error, limit);
};

class ResourceAddressError extends Error {}

class EntryOperationFailure extends Error {
    readonly result: SchemeResult;

    constructor(result: SchemeResult) {
        super(result.problem?.detail ?? `Entry operation failed with status ${result.status}.`, {
            cause: result.problem,
        });
        this.result = result;
    }
}

const requireEntrySuccess = <T extends EntryStorageReadResult | EntryStorageWriteResult>(
    result: T,
): T => {
    const exact = Results.assert(result);
    if (Results.isErrorStatus(exact.status)) throw new EntryOperationFailure(exact);
    return exact;
};

const resourcePath = (uri: string): string =>
    `${RESOURCE_PREFIX}${encodeURIComponent(uri)}`;

const promptPath = (name: string): string =>
    `${PROMPT_PREFIX}${encodeURIComponent(name)}`;

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

const catalogEntry = (content: string, kind: string): EntryData => ({
    channels: {
        body: {
            content,
            mimetype: "application/json",
        },
    },
    attributes: { kind },
});

export default class McpResources {
    readonly #server: string;
    readonly #connection: ServerConnection;
    readonly #catalog: ServerCatalog;

    constructor(server: string, connection: ServerConnection, catalog: ServerCatalog) {
        this.#server = server;
        this.#connection = connection;
        this.#catalog = catalog;
    }

    claims(pathname: string): boolean {
        return pathname === ROOT
            || pathname === RESOURCES
            || pathname.startsWith(RESOURCE_PREFIX)
            || pathname === PROMPTS
            || pathname.startsWith(PROMPT_PREFIX);
    }

    async #materializeCatalog(ctx: SchemeCtx): Promise<void> {
        const resources = this.#catalog.resources.map((resource) => ({
            ...resource,
            address: `${this.#server}://${resourcePath(resource.uri)}`,
        }));
        const prompts = this.#catalog.prompts.map((prompt) => ({
            ...prompt,
            address: `${this.#server}://${promptPath(prompt.name)}`,
        }));
        requireEntrySuccess(await ctx.entries.write(
            ROOT,
            catalogEntry(JSON.stringify({
                resources,
                resourceTemplates: this.#catalog.resourceTemplates,
                prompts,
            }), "mcp-resource-index"),
        ));
        requireEntrySuccess(await ctx.entries.write(
            RESOURCES,
            catalogEntry(JSON.stringify({
                resources,
                resourceTemplates: this.#catalog.resourceTemplates,
            }), "mcp-resource-index"),
        ));
        requireEntrySuccess(await ctx.entries.write(
            PROMPTS,
            catalogEntry(JSON.stringify({ prompts }), "mcp-prompt-index"),
        ));
        await Promise.all(this.#catalog.resources.map(async (resource) => {
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
        await Promise.all(this.#catalog.prompts.map(async (prompt) => {
            const pathname = promptPath(prompt.name);
            const existing = requireEntrySuccess(await ctx.entries.read(pathname));
            if (existing.entry?.attributes?.kind === PROMPT_KIND) return;
            requireEntrySuccess(await ctx.entries.write(
                pathname,
                catalogEntry(
                    JSON.stringify({
                        ...prompt,
                        address: `${this.#server}://${pathname}`,
                    }),
                    "mcp-prompt-catalog",
                ),
            ));
        }));
    }

    async #materializePrompt(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<void> {
        const encoded = request.pathname.slice(PROMPT_PREFIX.length);
        if (encoded.length === 0 || encoded.includes("/")) {
            throw new ResourceAddressError(`Invalid MCP prompt address '${request.pathname}'.`);
        }
        let name: string;
        try {
            name = decodeURIComponent(encoded);
        } catch (cause) {
            throw new ResourceAddressError(`Invalid encoded MCP prompt address '${request.pathname}'.`, { cause });
        }
        const search = new URLSearchParams(
            request.target.kind === "url" ? request.target.query ?? "" : "",
        );
        const args: Record<string, string> = {};
        for (const [key, value] of search) {
            if (Object.hasOwn(args, key)) {
                throw new ResourceAddressError(`MCP prompt argument '${key}' occurs more than once.`);
            }
            args[key] = value;
        }
        const result = await this.#connection.getPrompt(
            name,
            Object.keys(args).length === 0 ? undefined : args,
            ctx.signal,
            (interaction) => ctx.interactions.request(interaction),
        );
        requireEntrySuccess(await ctx.entries.write(request.pathname, {
            channels: {
                body: {
                    content: JSON.stringify(result),
                    mimetype: "application/json",
                },
            },
            attributes: { kind: PROMPT_KIND },
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
        const body = resourceBody(await this.#connection.readResource(
            uri,
            ctx.signal,
            (interaction) => ctx.interactions.request(interaction),
        ));
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
            } else if (pathname.startsWith(PROMPT_PREFIX) && !/[*?[\]{}]/.test(pathname)) {
                await this.#materializePrompt(request, ctx);
            } else {
                await this.#materializeCatalog(ctx);
            }
            return { status: 200 };
        } catch (error) {
            if (error instanceof EntryOperationFailure) {
                return preparationEntryFailure(error);
            }
            const invalidAddress = error instanceof ResourceAddressError;
            return preparationFailure(
                this.#server,
                invalidAddress ? "resource-address-invalid" : "resource-read-failed",
                invalidAddress ? 400 : 502,
                invalidAddress
                    ? "The MCP resource address is invalid."
                    : "MCP resource preparation failed.",
                {
                    diagnostic: diagnostic(error),
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
            if (error instanceof EntryOperationFailure) return findEntryFailure(error);
            return findFailure(
                this.#server,
                "resource-find-failed",
                502,
                "MCP resource listing failed.",
                {
                    diagnostic: diagnostic(error),
                    retryable: true,
                },
            );
        }
    }
}
