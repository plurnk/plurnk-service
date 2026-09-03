// Data statement execution: resolves the addressed entry and runs the scheme operation, split out of Dispatcher.
import type { ByteSource } from "../content/byte-view.ts";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { entryCoordinateOf, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { ReadProjector } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryOps from "../schemes/_entry-ops.ts";
import EntryFind from "../schemes/_entry-find.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import Results from "./results.ts";
import { CoreSchemeAdapterBase, type CoreRepresentationProvider } from "./CoreSchemeServices.ts";
import { InvalidOperationResultError, type SchemeHandler } from "@plurnk/plurnk-schemes";
import { type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import type { DispatchResult, SchemeMethod, UnaryStatement, SchemeWithEntryAddress } from "./Dispatcher.ts";

export default class DataStatementRunner {
    readonly #schemes: SchemeRegistry;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; }) => Promise<PreparedRepresentation>;
    readonly #fixedEntryOwnerId: (manifest: SchemeManifest, ctx: PlurnkSchemeContext) => Promise<number | null>;
    readonly #prepareDataRepresentation: (arg0: { target: ParsedPath; metadata: readonly string[] | null; routedScheme: string; handler: SchemeWithEntryAddress & SchemeHandler; manifest: SchemeManifest; ctx: PlurnkSchemeContext; publishedChannel: string | null; resolved?: PreparedRepresentation; }) => Promise<PreparedRepresentation>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({ schemes, liveSubscriptions, resolveDataEntryAddress, fixedEntryOwnerId, prepareDataRepresentation, failure }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; }) => Promise<PreparedRepresentation>;
        fixedEntryOwnerId: (manifest: SchemeManifest, ctx: PlurnkSchemeContext) => Promise<number | null>;
        prepareDataRepresentation: (arg0: { target: ParsedPath; metadata: readonly string[] | null; routedScheme: string; handler: SchemeWithEntryAddress & SchemeHandler; manifest: SchemeManifest; ctx: PlurnkSchemeContext; publishedChannel: string | null; resolved?: PreparedRepresentation; }) => Promise<PreparedRepresentation>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
        this.#fixedEntryOwnerId = fixedEntryOwnerId;
        this.#prepareDataRepresentation = prepareDataRepresentation;
        this.#failure = failure;
    }

    // {§membership-read-refusal} — a data scheme that can tell a plain miss from a refused one
    // (file: exists on disk, not a member) speaks first.
    async #missRefusal(handler: unknown, target: ParsedPath, ctx: PlurnkSchemeContext): Promise<DispatchResult | null> {
        const describe = (handler as {
            missRefusal?: (pathname: string, ctx: PlurnkSchemeContext, fields: Record<string, null>) => Promise<DispatchResult | null>;
        }).missRefusal;
        if (typeof describe !== "function") return null;
        const pathname = target.kind === "url" ? target.pathname : target.raw;
        return describe.call(handler, pathname, ctx, { content: null, mimetype: null, channel: null });
    }

    async run(
        schemeName: string | null,
        statement: UnaryStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (schemeName === null) {
            const fields = statement.op === "READ"
                ? { content: null, mimetype: null, channel: null }
                : statement.op === "FIND"
                    ? {
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsWeightTotal: 0,
                        returnedItemsWeightTotal: 0,
                        matchingPathCount: 0,
                        matchLocationCount: 0,
                    }
                    : {};
            return this.#failure(
                "target-scheme-required",
                400,
                `${statement.op} requires a target scheme.`,
                fields,
                { operation: statement.op, retryable: false },
            );
        }
        const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
        const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as Partial<Record<keyof SchemeHandler, SchemeMethod>> | undefined;
        if (handler === undefined) {
            return this.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const methodName = statement.op.toLowerCase() as keyof SchemeHandler;
        const method = handler[methodName];
        const addressedScheme = statement.target?.kind === "url" ? statement.target.scheme : null;
        if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
        // Metadata belongs to the handler that receives it. EXEC over a
        // non-file resource is the one split route: exec hosts the operation,
        // while the canonically routed source scheme receives the metadata.
        // {§exec-executor-slot} — an EXEC's metadata belongs to the resource its path names when
        // that is a URL; otherwise the executor reads it (`{cwd=…}`).
        const execResource = schemeName === "exec" && statement.op === "EXEC" ? statement.target : null;
        const metadataScheme = execResource?.kind === "url" && execResource.scheme !== "file"
            ? schemeNameOf(execResource) ?? schemeName
            : schemeName;
        const metadataManifest = metadataScheme === schemeName
            ? manifest
            : this.#schemes.manifestFor(metadataScheme, ctx.functionalityWorkerId);
        if (statement.metadata !== null && metadataManifest === undefined) {
            return this.#failure(
                "scheme-not-found",
                501,
                `Scheme '${metadataScheme}' is not registered.`,
                {},
                { scheme: metadataScheme, retryable: false },
            );
        }
        if (statement.metadata !== null && metadataManifest?.metadataModifier !== true) {
            return this.#failure(
                "scheme-metadata-unsupported",
                400,
                `Scheme '${metadataScheme}' does not accept the {metadata} modifier.`,
                {},
                {
                    scheme: metadataScheme,
                    operation: statement.op,
                    retryable: false,
                },
            );
        }
        const publishedChannel = statement.target?.kind === "url"
            ? statement.target.fragment ?? manifest.defaultChannel
            : manifest.defaultChannel;
        const authoredCoordinate = statement.target === null
            ? { authority: "", pathname: "" }
            : entryCoordinateOf(statement.target, manifest.authority ?? "namespace");
        // EXEC's authored target belongs to its declared invocation contract;
        // a resource target is input to the executor, never the output-stream
        // address owned by the internal exec scheme. {§exec-target-routing}
        const addressResolution = manifest.category === "data"
            && statement.target !== null
            && statement.op !== "EXEC"
            ? await this.#resolveDataEntryAddress({
                target: statement.target,
                routedScheme: schemeName,
                handler: handler as unknown as SchemeWithEntryAddress,
                manifest,
                ctx,
            })
            : null;
        if (addressResolution?.result !== null && addressResolution?.result !== undefined) {
            return addressResolution.result;
        }
        const operationAddress = addressResolution?.address ?? null;
        const schemeCtx = new SchemeCtxImpl(
            ctx,
            addressedScheme ?? schemeName,
            manifest,
            this.#liveSubscriptions,
            {
                authority: operationAddress?.authority ?? authoredCoordinate.authority,
                ownerId: operationAddress?.ownerId ?? await this.#fixedEntryOwnerId(manifest, ctx),
                publishedChannel,
            },
        );
        if (
            statement.op === "READ"
            && handler instanceof CoreSchemeAdapterBase
            && typeof (handler as Partial<CoreRepresentationProvider>).resolveCoreRepresentation === "function"
        ) {
            const selectionNeutralTarget = statement.target?.kind === "url"
                ? {
                    ...statement.target,
                    raw: renderTarget({ ...statement.target, fragment: null }) ?? statement.target.raw,
                    fragment: null,
                }
                : statement.target;
            const resolved = await (handler as unknown as CoreRepresentationProvider)
                .resolveCoreRepresentation(selectionNeutralTarget, schemeCtx);
            if ("result" in resolved) return Results.assertReadResult(resolved.result);
            if (selectionNeutralTarget === null) {
                throw new InvalidOperationResultError(
                    `Core scheme '${schemeName}' resolved a targetless READ representation.`,
                );
            }
            const target = renderTarget(selectionNeutralTarget.kind === "url"
                ? selectionNeutralTarget
                : { scheme: null, pathname: selectionNeutralTarget.raw });
            if (target === null) {
                throw new TypeError(`Core scheme '${schemeName}' resolved an unrenderable READ target.`);
            }
            return Results.assertReadResult(await ReadProjector.project({
                statement,
                manifest,
                target,
                identity: target,
                representation: resolved.representation,
                mimetypes: ctx.mimetypes,
            }));
        }
        if (statement.op === "READ" && manifest.category === "data") {
            const prepared = statement.target === null
                ? { address: null, result: null }
                : await this.#prepareDataRepresentation({
                    target: statement.target,
                    metadata: statement.metadata,
                    routedScheme: schemeName,
                    handler: handler as unknown as SchemeWithEntryAddress & SchemeHandler,
                    manifest,
                    ctx,
                    publishedChannel,
                    ...(addressResolution === null ? {} : { resolved: addressResolution }),
                });
            if (prepared.result !== null) return prepared.result;
            const resolved = prepared.address;
            if (statement.target !== null && resolved === null) {
                const refusal = await this.#missRefusal(handler, statement.target, ctx);
                if (refusal !== null) return refusal;
                const target = renderTarget(statement.target.kind === "url"
                    ? statement.target
                    : { scheme: null, pathname: statement.target.raw });
                return Results.failure(
                    `scheme:${schemeName}`,
                    "entry-not-found",
                    404,
                    `No entry exists at ${target ?? "the requested address"}.`,
                    { content: null, mimetype: null, channel: null },
                    { target },
                );
            }
            const storageScheme = resolved?.scheme ?? manifest.storedScheme ?? addressedScheme ?? schemeName;
            const projected = Results.assertReadResult(await EntryOps.readWorkspaceEntry(
                statement,
                ctx,
                { ...manifest, name: storageScheme, storedScheme: storageScheme },
                resolved === null
                    ? null
                    : {
                        ownerId: resolved.ownerId,
                        authority: resolved.authority,
                        pathname: resolved.pathname,
                    },
                // {§read-bytes} — a scheme that can supply the resource's bytes hands READ its source.
                resolved === null
                    ? undefined
                    : (handler as { byteSource?: (pathname: string, ctx: PlurnkSchemeContext) => ByteSource }).byteSource?.(resolved.pathname, ctx),
            ));
            if (projected.status !== 404 || statement.target === null) return projected;
            return await this.#missRefusal(handler, statement.target, ctx) ?? projected;
        }
        if (statement.op !== "FIND" || manifest.category !== "data") {
            if (typeof method === "function") {
                return Results.assert(await method.call(handler, statement, schemeCtx));
            }
            return this.#failure(
                "operation-not-implemented",
                501,
                `Scheme '${schemeName}' does not implement ${statement.op}.`,
                {},
                {
                    scheme: schemeName,
                    operation: statement.op,
                    retryable: false,
                },
            );
        }
        const targetPathname = statement.target?.kind === "url"
            ? statement.target.pathname
            : statement.target?.raw ?? "";
        const collectionTarget = manifest.folderScopes === true
            && (targetPathname === "" || targetPathname.endsWith("/"));
        const exactTarget = statement.target !== null
            && !collectionTarget
            && !PathSyntax.hasGlob(authoredCoordinate.pathname);
        if (exactTarget && statement.target !== null) {
            const prepared = await this.#prepareDataRepresentation({
                target: statement.target,
                metadata: statement.metadata,
                routedScheme: schemeName,
                handler: handler as unknown as SchemeWithEntryAddress & SchemeHandler,
                manifest,
                ctx,
                publishedChannel,
                ...(addressResolution === null ? {} : { resolved: addressResolution }),
            });
            if (prepared.result !== null) return prepared.result;
            if (prepared.address === null) {
                const target = renderTarget(statement.target.kind === "url"
                    ? statement.target
                    : { scheme: null, pathname: statement.target.raw });
                return Results.failure(
                    `scheme:${schemeName}`,
                    "entry-not-found",
                    404,
                    `No entry exists at ${target ?? "the requested address"}.`,
                    {
                        content: null,
                        mimetype: null,
                        results: [],
                        itemsWeightTotal: 0,
                        returnedItemsWeightTotal: 0,
                        matchingPathCount: 0,
                        matchLocationCount: 0,
                    },
                    { target },
                );
            }
            const storageScheme = prepared.address.scheme
                ?? manifest.storedScheme
                ?? addressedScheme
                ?? schemeName;
            return Results.assert(await EntryFind.findWorkspaceEntries(
                statement,
                ctx,
                { ...manifest, name: storageScheme, storedScheme: storageScheme },
                {
                    ownerId: prepared.address.ownerId,
                    authority: prepared.address.authority,
                    pathname: prepared.address.pathname,
                },
            ));
        }
        if (typeof method === "function") {
            return Results.assert(await method.call(handler, statement, schemeCtx));
        }
        const prepareFind = handler.prepareFind;
        if (typeof prepareFind === "function") {
            const prepared = await prepareFind.call(handler, statement, schemeCtx);
            if (prepared.status >= 300) return Results.assert(prepared);
        }
        return Results.assert(await schemeCtx.entries.operations.find(statement));
    }

}
