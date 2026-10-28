import type { ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeCtx, SchemeHandler, StoredEntryData } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type DataStatementRunner from "./DataStatementRunner.ts";
import type { DeleteEntryResult, EntryData, ReadEntryResult, WriteEntryResult } from "../schemes/_entry-crud.ts";
import type { PlurnkSchemeContext, SchemeManifest, WriterTier } from "./scheme-types.ts";
import type { ClientEntryAcquisition, ComputedClientChannel, DispatchResult, SchemeWithEntryAddress } from "./Dispatcher.ts";
import EntryAddressBinding, { type BoundEntryAddress as ResolvedDataEntryAddress, type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import DbMessageCaps from "./caps/DbMessageCaps.ts";
import { CoreSchemeAdapterBase, coreRepresentationProvider, type ExecSource } from "./CoreSchemeServices.ts";
import ResourceBindings from "./ResourceBindings.ts";
import LineSelection from "../content/line-selection.ts";
import Results, { OperationFailureError } from "./results.ts";
import { entryAddress, renderAddress, renderAuthoredTarget, renderTarget, schemeNameOf } from "./plurnk-uri.ts";

interface CoreSchemeWithCrud {
    readEntry?: (pathname: string, ctx: SchemeCtx) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: SchemeCtx) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
    deleteChannel?: (pathname: string, channel: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
}

export default class EntryRepresentation {
    readonly #schemes: SchemeRegistry;
    readonly #weighContent: (text: string) => number;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #entryAddresses: EntryAddressBinding;
    readonly #dataRun: DataStatementRunner;
    readonly #workspaceRoot: (workspaceId: number) => Promise<string | null>;
    readonly #buildSchemeCtx: (ids: {
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence?: number; origin: WriterTier;
        client?: { readonly contextSessionId: number | null };
    }) => PlurnkSchemeContext;
    readonly #failure: <F extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>>(
        code: string,
        status: number,
        detail: string,
        fields?: F,
        extensions?: Readonly<Record<string, unknown>>,
    ) => DispatchResult & F;

    constructor({
        schemes,
        weighContent,
        liveSubscriptions,
        entryAddresses,
        dataRun,
        workspaceRoot,
        buildSchemeCtx,
        failure,
    }: {
        schemes: SchemeRegistry;
        weighContent: (text: string) => number;
        liveSubscriptions: LiveSubscriptions;
        entryAddresses: EntryAddressBinding;
        dataRun: DataStatementRunner;
        workspaceRoot: (workspaceId: number) => Promise<string | null>;
        buildSchemeCtx: (ids: {
            workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence?: number; origin: WriterTier;
            client?: { readonly contextSessionId: number | null };
        }) => PlurnkSchemeContext;
        failure: <F extends Readonly<Record<string, unknown>> = Readonly<Record<string, never>>>(
            code: string,
            status: number,
            detail: string,
            fields?: F,
            extensions?: Readonly<Record<string, unknown>>,
        ) => DispatchResult & F;
    }) {
        this.#schemes = schemes;
        this.#weighContent = weighContent;
        this.#liveSubscriptions = liveSubscriptions;
        this.#entryAddresses = entryAddresses;
        this.#dataRun = dataRun;
        this.#workspaceRoot = workspaceRoot;
        this.#buildSchemeCtx = buildSchemeCtx;
        this.#failure = failure;
    }

    async handlerContext(scheme: string, ctx: PlurnkSchemeContext, authority = ""): Promise<SchemeCtxImpl | null> {
        const manifest = this.#schemes.manifestFor(scheme, ctx.workspaceId);
        return manifest === undefined
            ? null
            : new SchemeCtxImpl(ctx, scheme, manifest, this.#liveSubscriptions, {
                authority,
            });
    }

    boundEntryContext(
        routedScheme: string,
        address: ResolvedDataEntryAddress,
        ctx: PlurnkSchemeContext,
    ): SchemeCtxImpl | null {
        const manifest = this.#schemes.manifestFor(routedScheme, ctx.workspaceId);
        return manifest?.category === "data"
            ? new SchemeCtxImpl(ctx, address.scheme, manifest, this.#liveSubscriptions, {
                authority: address.authority,
            })
            : null;
    }

    #coreCrud(scheme: string, workspaceId: number): CoreSchemeWithCrud | undefined {
        const handler = this.#schemes.get(scheme, workspaceId);
        return handler instanceof CoreSchemeAdapterBase
            ? handler as CoreSchemeAdapterBase & CoreSchemeWithCrud
            : undefined;
    }

    async readEntry(scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
        const handlerCtx = this.boundEntryContext(scheme, address, ctx);
        if (typeof handler?.readEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.readEntry(pathname, handlerCtx));
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return this.#failure(
                "entry-read-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry reads.`,
                { entry: null },
                {
                    stage: "entry-read",
                    scheme,
                    target: renderAddress(address),
                    retryable: false,
                },
            );
        }
        const result = Results.assert(await caps.read(pathname));
        return Results.assert({
            ...result,
            status: result.status,
            entry: result.entry === null
                ? null
                : {
                    channels: { ...result.entry.channels },
                    ...(result.entry.attributes === undefined
                        ? {}
                        : { attributes: { ...result.entry.attributes } }),
                },
        });
    }

    async writeEntry(scheme: string, address: ResolvedDataEntryAddress, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
        const handlerCtx = this.boundEntryContext(scheme, address, ctx);
        if (typeof handler?.writeEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.writeEntry(pathname, entry, handlerCtx));
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return this.#failure(
                "entry-write-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry writes.`,
                { created: false, entryId: null },
                {
                    stage: "entry-write",
                    scheme,
                    target: renderAddress(address),
                    retryable: false,
                },
            );
        }
        return Results.assert(await caps.write(pathname, entry));
    }

    async deleteEntry(scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
        const handlerCtx = this.boundEntryContext(scheme, address, ctx);
        if (typeof handler?.deleteEntry === "function" && handlerCtx !== null) {
            return Results.assert(await handler.deleteEntry(pathname, handlerCtx));
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return this.#failure(
                "entry-delete-not-implemented",
                501,
                `The '${scheme}' scheme does not provide entry deletion.`,
                {},
                {
                    stage: "entry-delete",
                    scheme,
                    target: renderAddress(address),
                    retryable: false,
                },
            );
        }
        return Results.assert(await caps.delete(pathname));
    }

    async deleteChannel(
        scheme: string,
        address: ResolvedDataEntryAddress,
        channel: string,
        ctx: PlurnkSchemeContext,
    ): Promise<DeleteEntryResult> {
        const { pathname } = address;
        const handler = this.#coreCrud(scheme, ctx.workspaceId);
        const handlerCtx = this.boundEntryContext(scheme, address, ctx);
        if (typeof handler?.deleteChannel === "function" && handlerCtx !== null) {
            return Results.assert(await handler.deleteChannel(pathname, channel, handlerCtx));
        }
        const caps = handlerCtx?.entries;
        if (caps === undefined) {
            return this.#failure(
                "channel-delete-not-implemented",
                501,
                `The '${scheme}' scheme does not provide channel deletion.`,
                {},
                {
                    stage: "channel-delete",
                    scheme,
                    target: renderAddress(address),
                    channel,
                    retryable: false,
                },
            );
        }
        return Results.assert(
            await caps.delete(pathname, channel),
        );
    }

    // {§scheme-address} A client read acquires `target` as exact READ does, from the session's perspective: the
    // representation a core scheme computes, or a data entry. Only core's own acquisition runs for it: a core scheme's
    // preparation, and the materialization of a message core retains, whichever module minted its address
    // ({§message-source-scheme}); never an extension's. Null for a target no data or computing scheme claims.
    async readClientEntry(context: {
        target: ParsedPath;
        workspaceId: number;
        sessionId: number;
    }): Promise<ClientEntryAcquisition | null> {
        const { target, workspaceId, sessionId } = context;
        const routedScheme = schemeNameOf(target);
        if (routedScheme === null) return null;
        const coreCtx = this.#buildSchemeCtx({ workspaceId, sessionId, loopId: 0, turnId: 0, origin: "client" });
        return ResourceBindings.using(this.#schemes, coreCtx, async (ctx) => {
            try {
                const binding = await ResourceBindings.resolve(target, ctx);
                if (binding === undefined) return null;
                const neutral = target.kind === "url"
                    ? { ...target, raw: renderTarget({ ...target, fragment: null }) ?? target.raw, fragment: null }
                    : target;
                const computing = coreRepresentationProvider(binding.handler);
                if (computing !== null) {
                    const resolved = await computing.resolveCoreRepresentation(neutral, ctx);
                    if ("result" in resolved) return resolved.result.status >= 400 ? { kind: "refused", result: resolved.result } : null;
                    return { kind: "computed", target: resolved.identity ?? renderAuthoredTarget(neutral), channels: this.#computedChannels(resolved) };
                }
                if (binding.manifest.category !== "data") return null;
                const handler = binding.handler;
                const coreScheme = this.#schemes.coreOwns(routedScheme);
                const resolved = coreScheme
                    ? await this.prepareDataRepresentation({ target, metadata: null, routedScheme, handler, manifest: binding.manifest, ctx, publishedChannel: null })
                    : await this.resolveDataEntryAddress({ target, routedScheme, handler, manifest: binding.manifest, ctx });
                if (resolved.result !== null && resolved.result.status >= 400) return { kind: "refused", result: resolved.result };
                if (resolved.address === null) return null;
                if (!coreScheme) {
                    const retained = await new DbMessageCaps(ctx, routedScheme).prepare(neutral.raw);
                    if (retained.status >= 400 && retained.status !== 404) return { kind: "refused", result: retained };
                }
                const rendered = resolved.address.scheme === "file"
                    ? entryAddress("file", "", resolved.address.pathname, await this.#workspaceRoot(workspaceId))
                    : renderAuthoredTarget(neutral);
                return { kind: "stored", address: {
                    scheme: resolved.address.scheme,
                    authority: resolved.address.authority,
                    pathname: resolved.address.pathname,
                    target: rendered,
                } };
            } catch (error) {
                if (error instanceof OperationFailureError) return { kind: "refused", result: error.result };
                throw error;
            }
        });
    }

    // {§scheme-address} {§log-kill-scope} A computed representation's channels as a client reads them:
    // deliberate trimming applied, each weighed as a stored channel is.
    #computedChannels(resolved: { readonly representation: StoredEntryData; readonly visibleLines?: Readonly<Record<string, readonly number[]>> }): Record<string, ComputedClientChannel> {
        return Object.fromEntries(Object.entries(resolved.representation.channels).map(([name, { content, mimetype, state }]) => {
            const retained = resolved.visibleLines?.[name];
            const visible = retained === undefined ? content : LineSelection.retain(content, retained).content;
            return [name, { content: visible, mimetype, state, weight: visible.length === 0 ? 0 : this.#weighContent(visible) }];
        }));
    }

    async bindEntryAddress(
        target: ParsedPath,
        ctx: PlurnkSchemeContext,
    ): Promise<PreparedRepresentation | null> {
        const routedScheme = schemeNameOf(target);
        if (routedScheme === null) return null;
        return ResourceBindings.using(this.#schemes, ctx, async (boundCtx) => {
            try {
                const binding = await ResourceBindings.resolve(target, boundCtx);
                if (binding?.manifest.category !== "data") return null;
                return this.resolveDataEntryAddress({ target, routedScheme,
                    handler: binding.handler, manifest: binding.manifest, ctx: boundCtx });
            } catch (error) {
                if (error instanceof OperationFailureError) return { address: null, result: error.result };
                throw error;
            }
        });
    }

    async resolveDataEntryAddress({
        target,
        routedScheme,
        handler,
        manifest,
        ctx,
        access = "read",
    }: {
        target: ParsedPath;
        routedScheme: string;
        handler: SchemeWithEntryAddress;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        access?: "read" | "write";
    }): Promise<PreparedRepresentation> {
        if (manifest.category !== "data") {
            throw new TypeError(`Scheme '${routedScheme}' is not entry-bearing.`);
        }
        return this.#entryAddresses.resolve({ target, routedScheme, handler, manifest, ctx, access });
    }

    async prepareDataRepresentation({
        target,
        metadata,
        routedScheme,
        handler,
        manifest,
        ctx,
        publishedChannel,
        resolved: priorResolution,
    }: {
        target: ParsedPath;
        metadata: readonly string[] | null;
        routedScheme: string;
        handler: SchemeWithEntryAddress & SchemeHandler;
        manifest: SchemeManifest;
        ctx: PlurnkSchemeContext;
        publishedChannel: string | null;
        resolved?: PreparedRepresentation;
    }): Promise<PreparedRepresentation> {
        if (metadata !== null && manifest.metadataModifier !== true) {
            return {
                address: null,
                result: this.#failure(
                    "scheme-metadata-unsupported",
                    400,
                    `Resource acquisition from '${routedScheme}' does not accept the [metadata] modifier.`,
                    {},
                    { scheme: routedScheme, retryable: false },
                ),
            };
        }
        const resolved = priorResolution ?? await this.resolveDataEntryAddress({
            target, routedScheme, handler, manifest, ctx,
        });
        if (
            resolved.address === null
            || resolved.result !== null
            || typeof handler.prepareRepresentation !== "function"
        ) {
            return resolved;
        }
        const address = resolved.address;
        const selectionNeutralTarget = target.kind === "url"
            ? {
                ...target,
                raw: renderTarget({ ...target, fragment: null }) ?? target.raw,
                fragment: null,
            }
            : target;
        const preparationCtx = new SchemeCtxImpl(
            ctx,
            target.kind === "url" ? target.scheme : routedScheme,
            manifest,
            this.#liveSubscriptions,
            {
                authority: address.authority,
                publishedChannel,
            },
        );
        const prepared = Results.assertRepresentationPreparation(
            await handler.prepareRepresentation({
                target: selectionNeutralTarget,
                metadata,
                authority: address.authority,
                pathname: address.pathname,
            }, preparationCtx),
        );
        return {
            address,
            result: prepared.status === 200 ? null : prepared,
        };
    }

    // An accepted execution reads a non-file source through the same registered
    // handler and addressed context as an authored READ. {§exec-target-routing}
    async readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ExecSource> {
        return ResourceBindings.using(this.#schemes, ctx,
            (boundCtx) => this.#readExecSource(statement, boundCtx));
    }

    async #readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ExecSource> {
        const schemeName = schemeNameOf(statement.target);
        const binding = await ResourceBindings.resolve(statement.target, ctx);
        const manifest = binding?.manifest;
        if (manifest !== undefined && manifest.category !== "data") {
            return { nativePath: null, result: this.#failure(
                "exec-source-not-data",
                501,
                `Scheme '${schemeName}' is not a data source for an execution.`,
                {},
                {
                    scheme: schemeName,
                    category: manifest.category,
                    retryable: false,
                },
            ) };
        }
        const result = Results.assertReadResult(await this.#dataRun.run(schemeName, statement, ctx));
        const target = statement.target;
        const handler = binding?.handler;
        const selectedChannel = target?.fragment ?? null;
        if (result.status !== 200 || target === null || handler === undefined || manifest?.category !== "data"
            || (selectedChannel !== null && selectedChannel !== manifest.defaultChannel)) {
            return { result, nativePath: null };
        }
        const resolved = await this.resolveDataEntryAddress({ target, routedScheme: schemeName!, handler, manifest, ctx });
        if (resolved.result !== null) return { result: resolved.result, nativePath: null };
        const source = resolved.address === null ? undefined : handler.byteSource?.(resolved.address, EntryAddressBinding.addressContext(ctx));
        if (source?.nativePath === undefined) return { result, nativePath: null };
        const nativePath = await source.nativePath();
        if (nativePath === null) return { nativePath: null, result: this.#failure(
            "entry-not-found", 404, "The execution's source file no longer exists.", {}, { target: target.raw },
        ) };
        return { result, nativePath };
    }
}
