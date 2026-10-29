import {
    Results,
    ResourceNames,
    type EntryCaps,
    type EntryData,
    type EntryFindResult,
    type EntryStorageReadResult,
    type EntryStorageWriteResult,
    type FindStatement,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type RuntimeSchemeFacet,
    type SchemeCtx,
    type SchemeResult,
    type SendStatement,
    type StreamSubscription,
} from "@plurnk/plurnk-schemes";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import { ErrorDetail } from "@plurnk/plurnk-execs";
import type ServerConnection from "./client.ts";
import { AuthorizationRequiredError, awaitsSignIn, type ServerCatalog } from "./client.ts";
import ResourceContent from "./ResourceContent.ts";
import ContentProjection from "./ContentProjection.ts";

const ROOT = "/";
const RESOURCES = "/resources";
const RESOURCE_PREFIX = `${RESOURCES}/`;
const PROMPTS = "/prompts";
const PROMPT_PREFIX = `${PROMPTS}/`;
const MESSAGES = "/messages";
const MESSAGE_PREFIX = `${MESSAGES}/`;
const RESOURCE_KIND = "mcp-resource";
const CATALOG_KIND = "mcp-resource-catalog";
const PROMPT_KIND = "mcp-prompt";

const diagnostic = (error: unknown): string => ErrorDetail.preview(error);

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

export const resourcePath = (uri: string): string =>
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
);

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
);

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

const catalogEntry = (content: string, kind: string): EntryData => ({
    channels: {
        body: {
            content,
            mimetype: "application/json",
        },
    },
    attributes: { kind },
});

interface ResourceStreamWatcher {
    readonly uri: string;
    readonly root: string;
    readonly entries: EntryCaps;
    readonly meta: Readonly<Record<string, unknown>> | undefined;
    readonly subscription: StreamSubscription;
}

export default class McpResources {
    readonly #server: string;
    readonly #connection: ServerConnection;
    readonly #catalog: ServerCatalog;
    readonly #resolveCallerMeta: ((workspaceId: number, sessionId: number) => Promise<Readonly<Record<string, unknown>> | undefined>) | undefined;
    readonly #openStreams: boolean;
    readonly #resourceStreams = new Map<string, ResourceStreamWatcher>();

    constructor(
        server: string,
        connection: ServerConnection,
        catalog: ServerCatalog,
        resolveCallerMeta?: (workspaceId: number, sessionId: number) => Promise<Readonly<Record<string, unknown>> | undefined>,
        openStreams = true,
    ) {
        this.#server = server;
        this.#connection = connection;
        this.#catalog = catalog;
        this.#resolveCallerMeta = resolveCallerMeta;
        this.#openStreams = openStreams;
    }

    get manifest(): RuntimeSchemeFacet["manifest"] {
        return {
            channels: { body: "text/markdown" },
            defaultChannel: "body",
            writableBy: ["model", "client", "_plurnk"],
        };
    }

    claims(pathname: string): boolean {
        return pathname === ROOT
            || pathname === RESOURCES
            || pathname.startsWith(RESOURCE_PREFIX)
            || pathname === PROMPTS
            || pathname.startsWith(PROMPT_PREFIX)
            || pathname === MESSAGES
            || pathname.startsWith(MESSAGE_PREFIX);
    }

    async notifyResourceUpdated(uri: string): Promise<void> {
        const watcher = this.#resourceStreams.get(uri);
        if (watcher === undefined || watcher.subscription.aborted) return;
        this.#resourceStreams.delete(uri);
        try {
            const updated = await this.#connection.readResource(
                uri,
                watcher.subscription,
                undefined,
                watcher.meta,
            );
            if (watcher.subscription.aborted) return;
            await this.#writeResourceResult(watcher.root, updated, watcher.entries);
            if (watcher.subscription.aborted) return;
            await watcher.subscription.close({ status: 200 }, "resource updated");
        } catch (error) {
            if (watcher.subscription.aborted) return;
            await watcher.subscription.close(
                Results.failure(
                    "scheme:mcp",
                    "resource-update-failed",
                    502,
                    "MCP resource update read failed.",
                    {},
                    {
                        server: this.#server,
                        stage: "mcp-resource",
                        diagnostic: diagnostic(error),
                        retryable: true,
                    },
                ),
                "resource update failed",
            ).catch(() => undefined);
        }
    }

    async #materializeCatalog(ctx: SchemeCtx): Promise<void> {
        const resources = await Promise.all(this.#catalog.resources.map(async (resource) => ({
            ...resource,
            address: await ctx.entries.address(resourcePath(resource.uri)),
        })));
        const prompts = await Promise.all(this.#catalog.prompts.map(async (prompt) => ({
            ...prompt,
            address: await ctx.entries.address(promptPath(prompt.name)),
        })));
        requireEntrySuccess(await ctx.entries.write(
            ROOT,
            catalogEntry(JSON.stringify({
                resources,
                resourceTemplates: this.#catalog.resourceTemplates,
                prompts,
            }, null, 2), "mcp-resource-index"),
        ));
        requireEntrySuccess(await ctx.entries.write(
            RESOURCES,
            catalogEntry(JSON.stringify({
                resources,
                resourceTemplates: this.#catalog.resourceTemplates,
            }, null, 2), "mcp-resource-index"),
        ));
        requireEntrySuccess(await ctx.entries.write(
            PROMPTS,
            catalogEntry(JSON.stringify({ prompts }, null, 2), "mcp-prompt-index"),
        ));
        await Promise.all(this.#catalog.resources.map(async (resource) => {
            const pathname = resourcePath(resource.uri);
            const existing = await ctx.entries.read(pathname);
            if (existing.status !== 404) requireEntrySuccess(existing);
            if (existing.entry?.attributes?.kind === RESOURCE_KIND) return;
            requireEntrySuccess(await ctx.entries.write(
                pathname,
                catalogEntry(
                    JSON.stringify({
                        ...resource,
                        address: await ctx.entries.address(pathname),
                    }, null, 2),
                    CATALOG_KIND,
                ),
            ));
        }));
        await Promise.all(this.#catalog.prompts.map(async (prompt) => {
            const pathname = promptPath(prompt.name);
            const existing = await ctx.entries.read(pathname);
            if (existing.status !== 404) requireEntrySuccess(existing);
            if (existing.entry?.attributes?.kind === PROMPT_KIND) return;
            requireEntrySuccess(await ctx.entries.write(
                pathname,
                catalogEntry(
                    JSON.stringify({
                        ...prompt,
                        address: await ctx.entries.address(pathname),
                    }, null, 2),
                    "mcp-prompt-catalog",
                ),
            ));
        }));
    }

    async #materializePrompt(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<void> {
        const [encoded, folder, leaf, ...tail] = request.pathname.slice(PROMPT_PREFIX.length).split("/");
        if (!encoded || (folder !== undefined && (folder !== "resources" || !leaf || tail.length !== 0))) {
            throw new ResourceAddressError(`Invalid MCP prompt address '${request.pathname}'.`);
        }
        if (folder !== undefined) {
            requireEntrySuccess(await ctx.entries.read(request.pathname));
            return;
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
        const meta = this.#resolveCallerMeta === undefined
            ? undefined
            : await this.#resolveCallerMeta(ctx.workspaceId, ctx.sessionId);
        const result = await this.#connection.getPrompt(
            name,
            Object.keys(args).length === 0 ? undefined : args,
            ctx.signal,
            (interaction, signal) => ctx.interactions.request(interaction, signal),
            meta,
        );
        const names = new ResourceNames();
        const messages = [];
        for (const message of result.messages) {
            const content = await ContentProjection.project(message.content, {
                address: (uri) => ctx.entries.address(resourcePath(uri)),
                publish: async (channel, resourceName) => {
                    const child = `${request.pathname}/resources/${names.allocate(resourceName, JSON.stringify(message.content))}`;
                    requireEntrySuccess(await ctx.entries.write(child, {
                        channels: { body: channel },
                        attributes: { kind: RESOURCE_KIND },
                    }));
                    return ctx.entries.address(child);
                },
            });
            messages.push({ ...message, content });
        }
        requireEntrySuccess(await ctx.entries.write(request.pathname, {
            channels: {
                body: {
                    content: JSON.stringify({ ...result, messages }, null, 2),
                    mimetype: "application/json",
                },
                json: { content: JSON.stringify(result, null, 2), mimetype: "application/json" },
            },
            attributes: { kind: PROMPT_KIND },
        }));
    }

    async #writeResourceResult(
        root: string,
        result: Awaited<ReturnType<ServerConnection["readResource"]>>,
        entries: EntryCaps,
    ): Promise<string[]> {
        const names = new ResourceNames();
        const paths: string[] = [];
        if (result.contents.length !== 1) {
            for (const resource of result.contents) {
                const child = `${root}/resources/${names.allocate(ResourceContent.name(resource), resource.uri)}`;
                requireEntrySuccess(await entries.write(child, {
                    channels: { body: ResourceContent.channel(resource) },
                    attributes: { kind: RESOURCE_KIND },
                }));
                paths.push(child);
            }
        }
        const body = result.contents.length === 1 ? ResourceContent.channel(result.contents[0])
            : { content: (await Promise.all(paths.map(async (path) => `<${await entries.address(path)}>`))).join("\n"), mimetype: "text/markdown" };
        requireEntrySuccess(await entries.write(root, {
            channels: {
                body,
                json: { content: JSON.stringify(result, null, 2), mimetype: "application/json" },
            },
            attributes: { kind: RESOURCE_KIND },
        }));
        return paths;
    }

    async #materializeResource(pathname: string, ctx: SchemeCtx): Promise<void> {
        const [encoded, folder, leaf, ...tail] = pathname.slice(RESOURCE_PREFIX.length).split("/");
        if (!encoded || (folder !== undefined && (folder !== "resources" || !leaf || tail.length !== 0))) {
            throw new ResourceAddressError(`Invalid MCP resource address '${pathname}'.`);
        }
        let uri: string;
        try {
            uri = decodeURIComponent(encoded);
        } catch (cause) {
            throw new ResourceAddressError(`Invalid encoded MCP resource address '${pathname}'.`, { cause });
        }
        const meta = this.#resolveCallerMeta === undefined
            ? undefined
            : await this.#resolveCallerMeta(ctx.workspaceId, ctx.sessionId);
        const result = await this.#connection.readResource(
            uri,
            ctx.signal,
            (interaction, signal) => ctx.interactions.request(interaction, signal),
            meta,
        );
        const root = `${RESOURCE_PREFIX}${encoded}`;
        const paths = await this.#writeResourceResult(root, result, ctx.entries);
        if (pathname !== root && !paths.includes(pathname)) {
            throw new EntryOperationFailure(Results.failure("scheme:mcp", "resource-part-not-found", 404, "The resource response does not contain this part.", {}, { target: await ctx.entries.address(pathname) }));
        }
        if (
            this.#openStreams
            && this.#catalog.capabilities.resources?.subscribe === true
            && pathname === root
            && ctx.loopId > 0
            && "subscriptions" in ctx
            && ctx.subscriptions !== undefined
            && !this.#resourceStreams.has(uri)
        ) {
            let closed = false;
            const subscription = await ctx.subscriptions.open(root, {
                cancel: async () => {
                    const active = this.#resourceStreams.get(uri)?.subscription;
                    this.#resourceStreams.delete(uri);
                    if (closed || active === undefined) return;
                    closed = true;
                    await active.close(
                        Results.failure(
                            "lifecycle:cancel",
                            "stream-cancelled",
                            499,
                            "The MCP resource watch was cancelled.",
                            {},
                            { server: this.#server, stage: "mcp-resource", retryable: false },
                        ),
                        "resource watch cancelled",
                    );
                },
            });
            this.#resourceStreams.set(uri, {
                uri,
                root,
                entries: ctx.entries,
                meta,
                subscription,
            });
        }
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        const pathname = request.pathname;
        try {
            if (pathname === MESSAGES || pathname.startsWith(MESSAGE_PREFIX)) {
                return await ctx.messages.prepare(request.target.raw);
            }
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
            if (error instanceof AuthorizationRequiredError) {
                // {§mcp-host-composition} — the alias now awaits a sign-in.
                return preparationFailure(this.#server, "authorization-required", 401, awaitsSignIn(this.#server), { retryable: false });
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
            if (statement.target !== null && statement.target.kind === "url") {
                const pathname = PathSyntax.decodeParens(statement.target.pathname);
                if (pathname === MESSAGES || pathname.startsWith(MESSAGE_PREFIX)) {
                    const prepared = await ctx.messages.prepare();
                    if (Results.isErrorStatus(prepared.status)) {
                        return findEntryFailure(new EntryOperationFailure(prepared));
                    }
                    return await ctx.entries.operations.find(statement);
                }
            }
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

    async send(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.messages.reply(statement);
    }
}
