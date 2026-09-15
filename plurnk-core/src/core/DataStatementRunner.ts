// Data statement execution: resolves the addressed entry and runs the scheme operation, split out of Dispatcher.
import type { FindStatement, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import ResourceBindings from "./ResourceBindings.ts";
import { entryCoordinateOf, renderTarget } from "./plurnk-uri.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { ReadProjector } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryOps from "../schemes/_entry-ops.ts";
import EntryFind from "../schemes/_entry-find.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import Results from "./results.ts";
import { coreRepresentationProvider } from "./CoreSchemeServices.ts";
import { InvalidOperationResultError, type SchemeHandler } from "@plurnk/plurnk-schemes";
import { type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import type { DispatchResult, SchemeMethod, UnaryStatement, SchemeWithEntryAddress } from "./Dispatcher.ts";
import { isExecution } from "@plurnk/plurnk-contracts";
import { writtenOp } from "@plurnk/plurnk-contracts";

type SchemeMethods = Partial<Record<keyof SchemeHandler, SchemeMethod>>;

// The statement bound to its scheme: what every op runner shares once the target's
// scheme, manifest, metadata admission and entry address are settled.
interface BoundStatement {
    readonly schemeName: string;
    readonly statement: UnaryStatement;
    readonly ctx: PlurnkSchemeContext;
    readonly manifest: SchemeManifest;
    readonly handler: SchemeMethods;
    readonly method: SchemeMethod | undefined;
    readonly addressedScheme: string | null;
    readonly publishedChannel: string;
    readonly authoredCoordinate: ReturnType<typeof entryCoordinateOf>;
    readonly addressResolution: PreparedRepresentation | null;
    readonly schemeCtx: SchemeCtxImpl;
}

export default class DataStatementRunner {
    readonly #schemes: SchemeRegistry;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; access?: "read" | "write"; }) => Promise<PreparedRepresentation>;
    readonly #prepareDataRepresentation: (arg0: { target: ParsedPath; metadata: readonly string[] | null; routedScheme: string; handler: SchemeWithEntryAddress & SchemeHandler; manifest: SchemeManifest; ctx: PlurnkSchemeContext; publishedChannel: string | null; resolved?: PreparedRepresentation; }) => Promise<PreparedRepresentation>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({ schemes, liveSubscriptions, resolveDataEntryAddress, prepareDataRepresentation, failure }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; access?: "read" | "write"; }) => Promise<PreparedRepresentation>;
        prepareDataRepresentation: (arg0: { target: ParsedPath; metadata: readonly string[] | null; routedScheme: string; handler: SchemeWithEntryAddress & SchemeHandler; manifest: SchemeManifest; ctx: PlurnkSchemeContext; publishedChannel: string | null; resolved?: PreparedRepresentation; }) => Promise<PreparedRepresentation>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
        this.#prepareDataRepresentation = prepareDataRepresentation;
        this.#failure = failure;
    }

    // The op's result shape with nothing in it: what a refusal carries so the receipt keeps the
    // op's own fields ({§operation-results}).
    static #emptyFields(op: string): Readonly<Record<string, unknown>> {
        if (op === "READ") return { content: null, mimetype: null, channel: null };
        if (op === "FIND") {
            return {
                content: null,
                mimetype: null,
                results: [],
                itemsWeightTotal: 0,
                returnedItemsWeightTotal: 0,
                matchingPathCount: 0,
                matchLocationCount: 0,
            };
        }
        return {};
    }

    static #renderedTarget(target: ParsedPath): string | null {
        return renderTarget(target.kind === "url" ? target : { scheme: null, pathname: target.raw });
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

    #entryNotFound(schemeName: string, target: ParsedPath, op: string): DispatchResult {
        const rendered = DataStatementRunner.#renderedTarget(target);
        return Results.failure(
            `scheme:${schemeName}`,
            "entry-not-found",
            404,
            `No entry exists at ${rendered ?? "the requested address"}.`,
            DataStatementRunner.#emptyFields(op),
            { target: rendered },
        );
    }

    async run(
        schemeName: string | null,
        statement: UnaryStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (schemeName === null) {
            return this.#failure(
                "target-scheme-required",
                400,
                `${writtenOp(statement)} requires a target scheme.`,
                DataStatementRunner.#emptyFields(writtenOp(statement)),
                { operation: writtenOp(statement), retryable: false },
            );
        }
        const resourceRead = statement.op === "READ" || statement.op === "FIND";
        const binding = resourceRead ? await ResourceBindings.resolve(statement.target, ctx) : undefined;
        const manifest = resourceRead ? binding?.manifest : this.#schemes.manifestFor(schemeName, ctx.workspaceId);
        const handler = (resourceRead ? binding?.handler : this.#schemes.get(schemeName, ctx.workspaceId)) as SchemeMethods | undefined;
        if (handler === undefined) {
            return this.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        // An execution is named by its runtime, not an op; its handler method is `exec`.
        const methodName = (isExecution(statement) ? "exec" : statement.op.toLowerCase()) as keyof SchemeHandler;
        const method = handler[methodName];
        const addressedScheme = statement.target?.kind === "url" ? statement.target.scheme : null;
        if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
        if (statement.metadata !== null && manifest.metadataModifier !== true) {
            return this.#failure(
                "scheme-metadata-unsupported",
                400,
                `Scheme '${schemeName}' does not accept the [metadata] modifier.`,
                {},
                {
                    scheme: schemeName,
                    operation: statement.op,
                    retryable: false,
                },
            );
        }
        const publishedChannel = statement.target?.fragment ?? manifest.defaultChannel;
        const authoredCoordinate = statement.target === null
            ? { authority: "", pathname: "" }
            : entryCoordinateOf(statement.target, manifest.authority ?? "namespace");
        // An execution's authored target belongs to its declared invocation contract;
        // a resource target is input to the executor, never the output-stream
        // address owned by the internal exec scheme. {§exec-target-routing}
        const addressResolution = manifest.category === "data"
            && statement.target !== null
            && !isExecution(statement)
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
                publishedChannel,
            },
        );
        const bound: BoundStatement = {
            schemeName, statement, ctx, manifest, handler, method, addressedScheme,
            publishedChannel, authoredCoordinate, addressResolution, schemeCtx,
        };
        if (statement.op === "READ") return this.#runRead(bound);
        if (statement.op === "FIND" && manifest.category === "data") return this.#runFind(bound);
        return this.#runMethod(bound);
    }

    // READ: a core representation, a data entry, or the scheme's own method, in that order.
    async #runRead(bound: BoundStatement): Promise<DispatchResult> {
        const { statement } = bound;
        if (statement.op !== "READ") throw new TypeError(`READ runner given ${statement.op}`);
        const grant = await this.#lineAnchorGrant(bound);
        if (grant.refusal !== null) return grant.refusal;
        const coreRepresentation = coreRepresentationProvider(bound.handler);
        if (coreRepresentation !== null) return this.#readCoreRepresentation(bound, statement, coreRepresentation, grant.publishesLineAnchors);
        if (bound.manifest.category === "data") return this.#readDataEntry(bound, statement, grant.publishesLineAnchors);
        return this.#runMethod(bound);
    }

    // {§line-anchor-write-authority}: initialization's producer is not the model's write grant, so a
    // scheme that edits by anchor but does not publish them on every READ is asked whether the
    // model may write this target; a ≥500 answer is the READ's result.
    async #lineAnchorGrant(bound: BoundStatement): Promise<{ publishesLineAnchors: boolean; refusal: DispatchResult | null }> {
        const { statement, manifest, schemeName, handler, ctx } = bound;
        const publishesLineAnchors = manifest.lineAnchors === true;
        if (publishesLineAnchors || manifest.category !== "data" || manifest.textEditScopes !== true
            || !manifest.writableBy.includes("model") || statement.target === null) {
            return { publishesLineAnchors, refusal: null };
        }
        const writable = await this.#resolveDataEntryAddress({
            target: statement.target, routedScheme: schemeName,
            handler: handler as unknown as SchemeWithEntryAddress, manifest,
            ctx: { ...ctx, writer: "model" }, access: "write",
        });
        if (writable.result !== null && writable.result.status >= 500) {
            return {
                publishesLineAnchors,
                refusal: Results.assertReadResult({ ...writable.result, content: null, mimetype: null, channel: null }),
            };
        }
        return { publishesLineAnchors: writable.address !== null, refusal: null };
    }

    async #readCoreRepresentation(
        bound: BoundStatement,
        statement: ReadStatement,
        coreRepresentation: NonNullable<ReturnType<typeof coreRepresentationProvider>>,
        publishesLineAnchors: boolean,
    ): Promise<DispatchResult> {
        const { manifest, schemeName, schemeCtx, ctx } = bound;
        const selectionNeutralTarget = statement.target?.kind === "url"
            ? {
                ...statement.target,
                raw: renderTarget({ ...statement.target, fragment: null }) ?? statement.target.raw,
                fragment: null,
            }
            : statement.target;
        const resolved = await coreRepresentation.resolveCoreRepresentation(selectionNeutralTarget, schemeCtx);
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
            publishesLineAnchors,
            target,
            identity: resolved.identity ?? target,
            representation: resolved.representation,
            ...(resolved.visibleLines === undefined ? {} : { visibleLines: resolved.visibleLines }),
            mimetypes: ctx.mimetypes,
            ...(ctx.weigh === undefined ? {} : { weigh: ctx.weigh }),
        }));
    }

    async #readDataEntry(bound: BoundStatement, statement: ReadStatement, publishesLineAnchors: boolean): Promise<DispatchResult> {
        const { manifest, schemeName, handler, ctx, schemeCtx, addressedScheme, addressResolution, publishedChannel } = bound;
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
            return this.#entryNotFound(schemeName, statement.target, "READ");
        }
        const storageScheme = resolved?.scheme ?? manifest.storedScheme ?? addressedScheme ?? schemeName;
        const projected = Results.assertReadResult(await EntryOps.readWorkspaceEntry(
            statement,
            ctx,
            { ...manifest, name: storageScheme, storedScheme: storageScheme },
            resolved === null
                ? null
                : {
                    authority: resolved.authority,
                    pathname: resolved.pathname,
                },
            publishesLineAnchors,
            // {§read-bytes} — a scheme that can supply the resource's bytes hands READ its source.
            resolved === null
                ? undefined
                : (handler as SchemeHandler).byteSource?.(resolved, schemeCtx),
        ));
        if (projected.status !== 404 || statement.target === null) return projected;
        return await this.#missRefusal(handler, statement.target, ctx) ?? projected;
    }

    // FIND on a data scheme: an exact target is one entry's own search; a glob, a collection, or
    // no target is the scheme's method, its prepared find, or the workspace's entries.
    async #runFind(bound: BoundStatement): Promise<DispatchResult> {
        const { statement, manifest, authoredCoordinate } = bound;
        if (statement.op !== "FIND") throw new TypeError(`FIND runner given ${statement.op}`);
        const targetPathname = statement.target?.kind === "url"
            ? statement.target.pathname
            : statement.target?.raw ?? "";
        const collectionTarget = manifest.folderScopes === true
            && (targetPathname === "" || targetPathname.endsWith("/"));
        const exactTarget = statement.target !== null
            && !collectionTarget
            && !PathSyntax.hasGlob(authoredCoordinate.authority)
            && !PathSyntax.hasGlob(authoredCoordinate.pathname);
        if (exactTarget && statement.target !== null) return this.#findExactEntry(bound, statement, statement.target);
        const { handler, method, schemeCtx } = bound;
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

    async #findExactEntry(bound: BoundStatement, statement: FindStatement, target: ParsedPath): Promise<DispatchResult> {
        const { manifest, schemeName, handler, ctx, addressedScheme, addressResolution, publishedChannel } = bound;
        const prepared = await this.#prepareDataRepresentation({
            target,
            metadata: statement.metadata,
            routedScheme: schemeName,
            handler: handler as unknown as SchemeWithEntryAddress & SchemeHandler,
            manifest,
            ctx,
            publishedChannel,
            ...(addressResolution === null ? {} : { resolved: addressResolution }),
        });
        if (prepared.result !== null) return prepared.result;
        if (prepared.address === null) return this.#entryNotFound(schemeName, target, "FIND");
        const storageScheme = prepared.address.scheme
            ?? manifest.storedScheme
            ?? addressedScheme
            ?? schemeName;
        return Results.assert(await EntryFind.findWorkspaceEntries(
            statement,
            ctx,
            { ...manifest, name: storageScheme, storedScheme: storageScheme },
            {
                authority: prepared.address.authority,
                pathname: prepared.address.pathname,
            },
        ));
    }

    // Every other op, and READ or FIND on a scheme that owns them: the scheme's method, or 501.
    async #runMethod(bound: BoundStatement): Promise<DispatchResult> {
        const { statement, schemeName, handler, method, schemeCtx } = bound;
        if (typeof method === "function") {
            return Results.assert(await method.call(handler, statement, schemeCtx));
        }
        return this.#failure(
            "operation-not-implemented",
            501,
            `Scheme '${schemeName}' does not implement ${isExecution(statement) ? "exec" : statement.op}.`,
            {},
            {
                scheme: schemeName,
                operation: statement.op,
                retryable: false,
            },
        );
    }

}
