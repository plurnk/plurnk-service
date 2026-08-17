import type {
    CopyStatement,
    EditStatement,
    LineMarker,
    MoveStatement,
    ParsedPath,
    PlurnkStatement,
    ResourceSelection,
    TextLineMarker,
} from "@plurnk/plurnk-contracts";
import {
    InvalidOperationResultError,
    type ResolvedEditStatement,
    type ScopeNormalization,
    type SchemeCtx,
    type SchemeHandler,
    type SchemeResult,
} from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { entryPathnameOf, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import {
    assertEditBatchReceipt,
    assertEditReceipt,
    assertResourceEffects,
    EditCollision,
    editReceipt,
    LineAnchors,
    LineMarkerOps,
    MimetypeBinary,
    PathMimetype,
    projectEditReceipt,
    type EditBatchReceipt,
    type LineAnchorCheck,
    type LineAnchorPrecondition,
    type ResourceEffect,
    type ResourceEffectAction,
} from "../content/index.ts";
import DbProjectionCaps from "./caps/DbProjectionCaps.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import Results from "./results.ts";

type DispatchResult = SchemeResult;

type EditPreparationContext = {
    readonly workspaceId: number;
    readonly loopId: number;
    readonly origin: WriterTier;
};

type PreparedEditBatch = {
    readonly initial: DispatchResult;
    readonly settled: Promise<DispatchResult>;
    aggregate: EditBatchReceipt | undefined;
    settle(result: DispatchResult): void;
};

type PreparedEdit = {
    readonly first: boolean;
    readonly index: number;
    readonly normalizationIndex: number | null;
    readonly batch: PreparedEditBatch;
};

type ResolvedDataEntryAddress = {
    readonly ownerId: number;
    readonly scheme: string;
    readonly pathname: string;
};

type PreparedRepresentation = {
    readonly address: ResolvedDataEntryAddress | null;
    readonly result: DispatchResult | null;
};

type ResourceAddress = {
    readonly target: ParsedPath;
    readonly scheme: string;
    readonly pathname: string;
    readonly identityPathname: string;
    readonly channel: string;
    readonly manifest: SchemeManifest;
};

type AddressedResourceSelection = ResourceAddress & {
    readonly lineMarker: TextLineMarker | null;
};

type ResolvedResourceSelection = ResourceAddress & {
    readonly lineMarker: LineMarker | null;
};

type SelectedSource = ResolvedResourceSelection & {
    readonly storageAddress: ResolvedDataEntryAddress;
    readonly content: string;
    readonly completeContent: string;
    readonly mimetype: string;
    readonly lineAnchorPrecondition: LineAnchorPrecondition | null;
    readonly scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
};

type DeferredMoveSource = {
    readonly target: ParsedPath;
    readonly lineMarker: LineMarker | null;
    readonly scheme: string;
    readonly pathname: string;
    readonly channel: string;
    readonly destination: string;
    readonly lineAnchorPrecondition: LineAnchorPrecondition | null;
};

type PendingResourceEffect = Pick<ResourceEffect, "target" | "action">;

type OrchestrationProposalAttrs = {
    readonly proposalScheme?: string;
    readonly proposalTarget?: {
        readonly scheme: string;
        readonly pathname: string;
    };
    readonly proposalEffects?: readonly PendingResourceEffect[];
    readonly moveSource?: DeferredMoveSource;
    readonly moveDestinationWritten?: string;
    readonly moveDestinationEffects?: readonly ResourceEffect[];
};

type RunOperation = (
    schemeName: string | null,
    statement: PlurnkStatement,
    ctx: PlurnkSchemeContext,
) => Promise<DispatchResult>;

type PrepareDataRepresentation = (args: {
    target: ParsedPath;
    routedScheme: string;
    handler: SchemeHandler;
    manifest: SchemeManifest;
    ctx: PlurnkSchemeContext;
    schemeCtx: SchemeCtx;
    publishedChannel: string | null;
}) => Promise<PreparedRepresentation>;

type ProposalIds = {
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
};

// Owns EDIT batch state and COPY/MOVE resource mutation composition.
// Dispatcher retains admission, generic scheme routing, proposal lifecycle, and journaling.
export default class ResourceMutations {
    static #failure(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): DispatchResult {
        return Results.failure("engine:dispatcher", code, status, detail, fields, extensions);
    }

    readonly #schemes: SchemeRegistry;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #run: RunOperation;
    readonly #checkWritable: (statement: PlurnkStatement, origin: WriterTier, workspaceId: number) => DispatchResult | null;
    readonly #checkFlagsGate: (statement: PlurnkStatement, loopId: number, workspaceId: number) => Promise<DispatchResult | null>;
    readonly #editTargetIdentity: (
        statement: EditStatement,
        workspaceId: number,
    ) => Promise<{ readonly key: string; readonly identity: string | null }>;
    readonly #canonicalFilePath: (pathname: string, workspaceId: number) => Promise<string | null>;
    readonly #prepareDataRepresentation: PrepareDataRepresentation;
    readonly #readEntry: (scheme: string, pathname: string, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
    readonly #writeEntry: (scheme: string, pathname: string, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
    readonly #deleteChannel: (
        scheme: string,
        pathname: string,
        channel: string,
        ctx: PlurnkSchemeContext,
    ) => Promise<DeleteEntryResult>;
    readonly #applyProposal: ProposalLifecycle["workerApply"];
    readonly #preparedEdits = new WeakMap<EditStatement, PreparedEdit>();

    constructor({
        schemes,
        liveSubscriptions,
        run,
        checkWritable,
        checkFlagsGate,
        editTargetIdentity,
        canonicalFilePath,
        prepareDataRepresentation,
        readEntry,
        writeEntry,
        deleteChannel,
        applyProposal,
    }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        run: RunOperation;
        checkWritable: (statement: PlurnkStatement, origin: WriterTier, workspaceId: number) => DispatchResult | null;
        checkFlagsGate: (statement: PlurnkStatement, loopId: number, workspaceId: number) => Promise<DispatchResult | null>;
        editTargetIdentity: (
            statement: EditStatement,
            workspaceId: number,
        ) => Promise<{ readonly key: string; readonly identity: string | null }>;
        canonicalFilePath: (pathname: string, workspaceId: number) => Promise<string | null>;
        prepareDataRepresentation: PrepareDataRepresentation;
        readEntry: (scheme: string, pathname: string, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
        writeEntry: (scheme: string, pathname: string, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
        deleteChannel: (
            scheme: string,
            pathname: string,
            channel: string,
            ctx: PlurnkSchemeContext,
        ) => Promise<DeleteEntryResult>;
        applyProposal: ProposalLifecycle["workerApply"];
    }) {
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#run = run;
        this.#checkWritable = checkWritable;
        this.#checkFlagsGate = checkFlagsGate;
        this.#editTargetIdentity = editTargetIdentity;
        this.#canonicalFilePath = canonicalFilePath;
        this.#prepareDataRepresentation = prepareDataRepresentation;
        this.#readEntry = readEntry;
        this.#writeEntry = writeEntry;
        this.#deleteChannel = deleteChannel;
        this.#applyProposal = applyProposal;
    }

    async #resolveEditAnchors(
        statements: readonly EditStatement[],
        identity: string | null,
        schemeName: string,
        manifest: SchemeManifest,
        ctx: PlurnkSchemeContext,
    ): Promise<{
        readonly statements: readonly ResolvedEditStatement[];
        readonly precondition: LineAnchorPrecondition | null;
    } | { readonly result: DispatchResult }> {
        const anchored = statements.filter(({ lineMarker }) => LineAnchors.hasAnchor(lineMarker));
        if (anchored.length === 0) {
            return { statements: statements as readonly ResolvedEditStatement[], precondition: null };
        }
        if (manifest.textEditScopes !== true || !manifest.writableBy.includes("model")) {
            return {
                result: ResourceMutations.#failure(
                    "line-anchor-unsupported",
                    400,
                    `Scheme '${schemeName}' does not support textual EDIT scopes.`,
                    {},
                    {
                        scheme: schemeName,
                        operation: "EDIT",
                        recovery: "Remove the scope and submit the scheme's complete editable unit.",
                        retryable: false,
                    },
                ),
            };
        }
        if (identity === null) {
            return {
                result: ResourceMutations.#failure(
                    "edit-target-required",
                    400,
                    "A line-anchored EDIT requires a target resource.",
                    {},
                    { recovery: "Provide the target that rendered the line anchor.", retryable: false },
                ),
            };
        }

        const first = statements[0];
        if (first === undefined) return { statements: [], precondition: null };
        const current = await this.#run(schemeName, {
            op: "READ",
            suffix: first.suffix,
            annotation: null,
            signal: null,
            target: first.target,
            lineMarker: { marks: [1, -1] },
            body: null,
            position: first.position,
        }, ctx);
        if (current.status === 204 || current.status === 404) {
            return { result: EditCollision.result(identity) };
        }
        if (current.status >= 300) {
            return {
                result: ResourceMutations.#failure(
                    "line-anchor-validation-failed",
                    current.status,
                    `EDIT could not validate its line anchor at ${identity}: ${current.problem?.detail ?? `READ returned ${current.status}`}`,
                    {},
                    {
                        target: identity,
                        upstreamStatus: current.status,
                        stage: "mutation-precondition",
                        retryable: false,
                    },
                ),
            };
        }
        if (current.status !== 200) {
            return { result: EditCollision.result(identity) };
        }
        const content = (current as { content?: unknown }).content;
        if (typeof content !== "string") {
            throw new InvalidOperationResultError(
                `Scheme '${schemeName}' returned READ ${current.status} without textual content while validating an EDIT anchor.`,
            );
        }
        const lineAnchors = (current as { lineAnchors?: unknown }).lineAnchors;
        const lineAnchorIdentity = (current as { lineAnchorIdentity?: unknown }).lineAnchorIdentity;
        try {
            LineAnchors.assertProjection(content, lineAnchors);
            if (typeof lineAnchorIdentity !== "string" || lineAnchorIdentity.length === 0) {
                throw new TypeError("READ line anchors require their canonical derivation identity.");
            }
        } catch (cause) {
            throw new InvalidOperationResultError(
                `Scheme '${schemeName}' returned READ 200 without its core-owned line-anchor projection.`,
                { cause },
            );
        }

        const resolved: ResolvedEditStatement[] = [];
        const checks: LineAnchorCheck[] = [];
        for (const statement of statements) {
            if (statement.lineMarker === null || !LineAnchors.hasAnchor(statement.lineMarker)) {
                resolved.push(statement as ResolvedEditStatement);
                continue;
            }
            const resolution = LineAnchors.resolve(lineAnchors, statement.lineMarker);
            if (!resolution.ok) {
                const { anchor, kind } = resolution.failure;
                const invalid = kind === "invalid";
                if (!invalid) return { result: EditCollision.result(lineAnchorIdentity) };
                return {
                    result: ResourceMutations.#failure(
                        "line-anchor-invalid",
                        400,
                        `${anchor} is not valid in that EDIT line-coordinate position.`,
                        {},
                        {
                            anchor,
                            target: identity,
                            recovery: "Use anchors only where the EDIT scope denotes a line.",
                            retryable: false,
                        },
                    ),
                };
            }
            for (const [index, anchor] of statement.lineMarker.marks.entries()) {
                if (typeof anchor !== "string") continue;
                const line = resolution.marker.marks[index];
                if (typeof line !== "number") {
                    throw new InvalidOperationResultError("An EDIT line anchor did not lower to a numeric line.");
                }
                checks.push({ anchor, line });
            }
            resolved.push({ ...statement, lineMarker: resolution.marker });
        }
        const uniqueChecks = [...new Map(checks.map((check) => [`${check.anchor}:${check.line}`, check])).values()];
        return {
            statements: resolved,
            precondition: { identity: lineAnchorIdentity, checks: uniqueChecks },
        };
    }

    async prepareEditBatches(
        statements: readonly EditStatement[],
        context: EditPreparationContext,
        schemeCtx: PlurnkSchemeContext,
    ): Promise<void> {
        const { workspaceId, loopId, origin } = context;
        const groups = new Map<string, { readonly identity: string | null; readonly statements: EditStatement[] }>();
        for (const statement of statements) {
            const { key, identity } = await this.#editTargetIdentity(statement, workspaceId);
            const group = groups.get(key);
            if (group === undefined) groups.set(key, {
                identity,
                statements: [statement],
            });
            else group.statements.push(statement);
        }
        for (const preparedGroup of groups.values()) {
            const group = preparedGroup.statements;
            const first = group[0];
            const schemeName = schemeNameOf(first.target);
            let initial: DispatchResult;
            let denial = group.map((statement) => this.#checkWritable(statement, origin, workspaceId)).find((result) => result !== null) ?? null;
            if (denial === null) {
                for (const statement of group) {
                    denial = await this.#checkFlagsGate(statement, loopId, workspaceId);
                    if (denial !== null) break;
                }
            }
            if (denial !== null) {
                initial = denial;
            } else if (schemeName === null) {
                initial = ResourceMutations.#failure(
                    "target-required",
                    400,
                    "EDIT requires a target scheme.",
                    {},
                    { retryable: false },
                );
            } else {
                const handler = this.#schemes.get(schemeName, workspaceId) as SchemeHandler | undefined;
                const method = handler?.editBatch;
                const manifest = this.#schemes.manifestFor(schemeName, workspaceId);
                if (typeof method !== "function" || manifest === undefined) {
                    initial = ResourceMutations.#failure(
                        "operation-not-implemented",
                        501,
                        `Scheme '${schemeName}' does not implement EDIT batches.`,
                        {},
                        {
                            scheme: schemeName,
                            operation: "EDIT",
                            retryable: false,
                        },
                    );
                } else {
                    try {
                        const resolved = await this.#resolveEditAnchors(
                            group,
                            preparedGroup.identity,
                            schemeName,
                            manifest,
                            schemeCtx,
                        );
                        if ("result" in resolved) {
                            initial = resolved.result;
                        } else {
                            const addressedScheme = first.target?.kind === "url" ? first.target.scheme : schemeName;
                            const publishedChannel = first.target?.kind === "url"
                                ? first.target.fragment ?? manifest.defaultChannel
                                : manifest.defaultChannel;
                            initial = Results.assert(await method.call(handler, resolved.statements, new SchemeCtxImpl(
                                schemeCtx,
                                addressedScheme ?? schemeName,
                                manifest,
                                this.#liveSubscriptions,
                                {
                                    publishedChannel,
                                    editPrecondition: resolved.precondition,
                                },
                            )));
                        }
                    } catch (err) {
                        if (err instanceof InvalidOperationResultError) throw err;
                        console.error(`Scheme '${schemeName}' EDIT batch threw outside its operation result contract:`, err);
                        initial = ResourceMutations.#failure(
                            "scheme-handler-threw",
                            500,
                            `The '${schemeName}' scheme did not produce an EDIT result.`,
                            {},
                            {
                                stage: "scheme-dispatch",
                                scheme: schemeName,
                                operation: "EDIT",
                            },
                        );
                    }
                }
            }
            let resolveSettled!: (result: DispatchResult) => void;
            const settled = new Promise<DispatchResult>((resolve) => { resolveSettled = resolve; });
            const candidate = initial.editReceipt;
            const expectedNormalizations = group.filter(({ lineMarker }) =>
                lineMarker?.marks.length === 3).length;
            if (
                initial.status < 400
                && (initial.scopeNormalizations?.length ?? 0) !== expectedNormalizations
            ) {
                throw new InvalidOperationResultError(
                    `EDIT batch normalized ${initial.scopeNormalizations?.length ?? 0} scope(s), expected ${expectedNormalizations}.`,
                );
            }
            const batch: PreparedEditBatch = {
                initial,
                settled,
                aggregate: candidate === undefined || candidate === null
                    ? undefined
                    : assertEditBatchReceipt(candidate),
                settle: resolveSettled,
            };
            let normalizationIndex = 0;
            for (const [index, statement] of group.entries()) {
                const ownsNormalization = statement.lineMarker?.marks.length === 3 && initial.status < 400;
                this.#preparedEdits.set(statement, {
                    first: index === 0,
                    index,
                    normalizationIndex: ownsNormalization ? normalizationIndex++ : null,
                    batch,
                });
            }
        }
    }

    preparedEditResult(statement: EditStatement): Promise<DispatchResult> {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared === undefined) {
            throw new InvalidOperationResultError("EDIT reached dispatch without a prepared resource batch.");
        }
        return this.#projectPreparedEdit(prepared);
    }

    async #projectPreparedEdit(prepared: PreparedEdit): Promise<DispatchResult> {
        const settled = prepared.first
            ? prepared.batch.initial
            : await prepared.batch.settled;
        const normalization = prepared.normalizationIndex === null
            ? undefined
            : settled.scopeNormalizations?.[prepared.normalizationIndex];
        const {
            scopeNormalizations: _scopeNormalizations,
            ...projectedSettlement
        } = settled;
        const statementResult = normalization === undefined
            ? projectedSettlement
            : { ...projectedSettlement, scopeNormalizations: [normalization] };
        const aggregate = prepared.batch.aggregate;
        if (aggregate === undefined) return statementResult;
        const receipt = assertEditBatchReceipt(aggregate);
        const { editReceipt: _editReceipt, ...withoutAggregate } = statementResult;
        return {
            ...withoutAggregate,
            receipt: projectEditReceipt(receipt, prepared.index),
        };
    }

    settleEdit(statement: EditStatement, result: DispatchResult): void {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared?.first !== true) return;
        const normalizations = prepared.batch.initial.scopeNormalizations;
        prepared.batch.settle(normalizations === undefined
            ? result
            : Results.assert({ ...result, scopeNormalizations: normalizations }));
    }

    async handleCopy(statement: CopyStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.target === null) {
            return ResourceMutations.#failure("copy-source-required", 400, "COPY requires a source path.", {}, { retryable: false });
        }
        if (statement.body === null) {
            return ResourceMutations.#failure(
                "copy-destination-required",
                400,
                "COPY requires a destination.",
                {},
                { retryable: false },
            );
        }
        return this.#copyOrchestration({
            statement,
            source: {
                target: statement.target,
                lineMarker: statement.lineMarker,
            },
            destination: statement.body,
            ctx,
        });
    }

    async handleMove(statement: MoveStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.target === null) {
            return ResourceMutations.#failure("move-source-required", 400, "MOVE requires a source path.", {}, { retryable: false });
        }
        // MOVE is relocation only - deletion is KILL's job ({§move}, {§move-dev-null-not-special}). The /dev/null
        // and null-body delete-by-MOVE has no alternate meaning.
        if (statement.body === null) {
            return ResourceMutations.#failure(
                "move-destination-required",
                400,
                "MOVE requires a destination.",
                {},
                {
                    recovery: "Use KILL when the intended operation is deletion.",
                    retryable: false,
                },
            );
        }
        const sourceMarks = statement.lineMarker?.marks;
        const sourceLineMarker = sourceMarks?.length === 2
            && sourceMarks[0] === 1
            && sourceMarks[1] === -1
            ? null
            : statement.lineMarker;
        return this.#moveOrchestration({
            statement,
            source: {
                target: statement.target,
                // Canonicalize only the execution selection. #writeLog retains
                // the authored marker as operation evidence. {§move-canonical-whole-source}
                lineMarker: sourceLineMarker,
            },
            destination: statement.body,
            ctx,
        });
    }

    static #isDispatchResult(
        value: AddressedResourceSelection | SelectedSource | DispatchResult,
    ): value is DispatchResult {
        return "status" in value;
    }

    async #resolveResourceSelection(
        selection: ResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<AddressedResourceSelection | DispatchResult> {
        const { target, lineMarker } = selection;
        const scheme = schemeNameOf(target);
        if (scheme === null) {
            return ResourceMutations.#failure(
                "resource-scheme-required",
                400,
                "COPY and MOVE resources require a scheme.",
                {},
                { retryable: false },
            );
        }
        if (target.kind === "url" && target.scheme === "worker" && (target.hostname ?? "") !== "") {
            return ResourceMutations.#failure(
                "worker-copy-address-invalid",
                400,
                "COPY and MOVE do not address named worker spaces.",
                {},
                {
                    recovery: "Move worker-space content with READ and EDIT.",
                    retryable: false,
                },
            );
        }
        const handler = this.#schemes.get(scheme, ctx.workspaceId);
        const manifest = this.#schemes.manifestFor(scheme, ctx.workspaceId);
        if (handler === undefined || manifest === undefined) {
            return ResourceMutations.#failure(
                "scheme-not-found",
                501,
                `COPY or MOVE addressed the unregistered scheme '${scheme}'.`,
                {},
                {
                    scheme,
                    retryable: false,
                },
            );
        }
        if (manifest.category !== "data") {
            return ResourceMutations.#failure(
                "entry-operation-unsupported",
                400,
                `COPY and MOVE require entry-bearing resources; '${scheme}' is a ${manifest.category} scheme.`,
                {},
                {
                    scheme,
                    category: manifest.category,
                    retryable: false,
                },
            );
        }
        const fragment = target.kind === "url" ? target.fragment : null;
        const channel = fragment ?? manifest.defaultChannel;
        if (channel.length === 0) {
            return ResourceMutations.#failure(
                "channel-required",
                400,
                `The '${scheme}' scheme has no default channel.`,
                {},
                {
                    scheme,
                    recovery: "Address a named channel with a URI fragment.",
                    retryable: false,
                },
            );
        }
        if (
            fragment !== null
            && fragment !== manifest.defaultChannel
            && !Object.hasOwn(manifest.channels, fragment)
        ) {
            const availableChannels = [
                ...new Set([manifest.defaultChannel, ...Object.keys(manifest.channels)]),
            ].filter((candidate) => candidate.length > 0);
            return ResourceMutations.#failure(
                "channel-not-found",
                400,
                `Channel #${fragment} is not declared by the '${scheme}' scheme.`,
                {},
                {
                    requestedChannel: fragment,
                    availableChannels,
                    retryable: false,
                },
            );
        }
        const pathname = entryPathnameOf(target);
        const canonicalFilePath = scheme === "file"
            ? await this.#canonicalFilePath(pathname, ctx.workspaceId)
            : pathname;
        return {
            target,
            lineMarker,
            scheme,
            pathname,
            identityPathname: canonicalFilePath ?? pathname,
            channel,
            manifest,
        };
    }

    #resolveResourceLineMarker(
        selection: AddressedResourceSelection,
        content: string,
        operation: "COPY" | "MOVE",
    ): { readonly selection: ResolvedResourceSelection; readonly precondition: LineAnchorPrecondition | null }
        | { readonly result: DispatchResult } {
        if (!LineAnchors.hasAnchor(selection.lineMarker)) {
            return {
                selection: {
                    ...selection,
                    lineMarker: selection.lineMarker as LineMarker | null,
                },
                precondition: null,
            };
        }
        const target = this.#resourceAddress(selection);
        if (selection.manifest.textEditScopes !== true || !selection.manifest.writableBy.includes("model")) {
            return {
                result: ResourceMutations.#failure(
                    "line-anchor-unsupported",
                    400,
                    `The representation at ${target} does not publish line anchors.`,
                    {},
                    {
                        operation,
                        target,
                        recovery: "Use numeric text coordinates.",
                        retryable: false,
                    },
                ),
            };
        }
        const resolution = LineAnchors.resolve(LineAnchors.tokens(target, content), selection.lineMarker);
        if (!resolution.ok) {
            if (resolution.failure.kind === "invalid") {
                return {
                    result: ResourceMutations.#failure(
                        "line-anchor-invalid",
                        400,
                        "A line anchor appeared outside a line-coordinate position.",
                        {},
                        {
                            operation,
                            target,
                            recovery: "Use anchors only for L, SL, or EL; columns remain numeric.",
                            retryable: false,
                        },
                    ),
                };
            }
            return {
                result: ResourceMutations.#failure(
                    "line-anchor-collision",
                    409,
                    `${operation} coordinates collided with current content at ${target}.`,
                    {},
                    {
                        operation,
                        target,
                        recovery: `READ ${target} again and retry against its current coordinates.`,
                        retryable: true,
                    },
                ),
            };
        }
        return {
            selection: { ...selection, lineMarker: resolution.marker },
            precondition: {
                identity: target,
                checks: LineAnchors.checks(selection.lineMarker, resolution.marker),
            },
        };
    }

    async #selectSource(
        selection: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
        operation: "COPY" | "MOVE",
    ): Promise<SelectedSource | DispatchResult> {
        const handler = this.#schemes.get(selection.scheme, ctx.workspaceId) as SchemeHandler | undefined;
        if (handler === undefined) {
            throw new InvalidOperationResultError(
                `Resolved COPY/MOVE source scheme '${selection.scheme}' is no longer registered.`,
            );
        }
        const addressedScheme = selection.target.kind === "url"
            ? selection.target.scheme
            : selection.scheme;
        const schemeCtx = new SchemeCtxImpl(
            ctx,
            addressedScheme,
            selection.manifest,
            this.#liveSubscriptions,
            { publishedChannel: selection.channel },
        );
        const prepared = await this.#prepareDataRepresentation({
            target: selection.target,
            routedScheme: selection.scheme,
            handler,
            manifest: selection.manifest,
            ctx,
            schemeCtx,
            publishedChannel: selection.channel,
        });
        if (prepared.result !== null) return prepared.result;
        if (prepared.address === null) {
            return ResourceMutations.#failure(
                "entry-not-found",
                404,
                `No entry exists at ${this.#resourceAddress(selection)}.`,
                {},
                { target: this.#resourceAddress(selection) },
            );
        }
        const storageAddress = prepared.address;
        const read = await EntryCrud.readEntry(
            storageAddress.pathname,
            ctx,
            storageAddress.scheme,
            storageAddress.ownerId,
        );
        if (read.status >= 400) return read;
        if (read.status !== 200 || read.entry === null) {
            throw new InvalidOperationResultError(
                `The '${selection.scheme}' scheme returned status ${read.status} without a COPY/MOVE source entry.`,
            );
        }
        const selected = read.entry.channels[selection.channel];
        if (selected === undefined) {
            return ResourceMutations.#failure(
                "channel-not-found",
                404,
                `No channel named #${selection.channel} exists at ${renderAddress(storageAddress.scheme, storageAddress.pathname)}.`,
                {},
                {
                    target: renderAddress(storageAddress.scheme, storageAddress.pathname),
                    requestedChannel: selection.channel,
                    availableChannels: Object.keys(read.entry.channels),
                    retryable: false,
                },
            );
        }
        const resolvedMarker = this.#resolveResourceLineMarker(selection, selected.content, operation);
        if ("result" in resolvedMarker) return resolvedMarker.result;
        let content = selected.content;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        if (await MimetypeBinary.isBinaryMimetype(selected.mimetype, ctx.mimetypes)) {
            return ResourceMutations.#failure(
                "binary-source-unsupported",
                415,
                `Channel #${selection.channel} is a binary marker and cannot be copied or moved.`,
                {},
                {
                    channel: selection.channel,
                    mimetype: selected.mimetype,
                    recovery: "Use a source with a readable text projection.",
                    retryable: false,
                },
            );
        }
        if (resolvedMarker.selection.lineMarker !== null) {
            const sliced = LineMarkerOps.sliceLinesRaw(content, resolvedMarker.selection.lineMarker);
            if (sliced.status !== 200) return Results.assert(sliced) as DispatchResult;
            content = sliced.text ?? "";
            scopeNormalizations = sliced.scopeNormalizations;
        }
        if (selected.producerResult !== undefined && selected.producerResult.status >= 400) {
            return Results.assert(selected.producerResult) as DispatchResult;
        }
        return {
            ...resolvedMarker.selection,
            storageAddress,
            content,
            completeContent: selected.content,
            mimetype: selected.mimetype,
            lineAnchorPrecondition: resolvedMarker.precondition,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };
    }

    static #prependScopeNormalizations(
        result: DispatchResult,
        scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined,
    ): DispatchResult {
        if (scopeNormalizations === undefined) return result;
        return Results.assert({
            ...result,
            scopeNormalizations: [
                ...scopeNormalizations,
                ...(result.scopeNormalizations ?? []),
            ],
        });
    }

    static #mergeLineAnchorPreconditions(
        ...values: ReadonlyArray<LineAnchorPrecondition | null>
    ): LineAnchorPrecondition | null {
        const present = values.filter((value): value is LineAnchorPrecondition => value !== null);
        if (present.length === 0) return null;
        const identity = present[0]!.identity;
        if (present.some((value) => value.identity !== identity)) {
            throw new TypeError("Line-anchor preconditions for one edit batch must share a resource identity.");
        }
        const checks = [...new Map(
            present.flatMap(({ checks: valueChecks }) => valueChecks)
                .map((check) => [`${check.anchor}:${check.line}`, check]),
        ).values()];
        return { identity, checks };
    }

    #resourceAddress(selection: ResourceAddress): string {
        const address = renderTarget({
            scheme: selection.scheme === "file" ? null : selection.scheme,
            pathname: selection.scheme === "file"
                ? selection.identityPathname.replace(/^\//, "")
                : selection.identityPathname,
            fragment: selection.channel === selection.manifest.defaultChannel
                ? null
                : selection.channel,
        });
        if (address === null) throw new Error("resolved resource selection has no renderable address");
        return address;
    }

    #pendingEffect(
        selection: ResourceAddress,
        action: ResourceEffectAction,
    ): PendingResourceEffect {
        return {
            target: this.#resourceAddress(selection),
            action,
        };
    }

    static #appliedEffects(
        result: DispatchResult,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        // {§edit-result-copy-move-effects} — only an applied mutation earns
        // engine-composed effects; native scheme receipts remain internal input.
        const exact = Results.assert(result);
        if (exact.status === 304 || exact.status === 202 || exact.status >= 300) return exact;
        if (exact.effects !== undefined) {
            throw new InvalidOperationResultError(
                "A COPY/MOVE mutation result supplied effects before engine composition.",
            );
        }
        const batch = exact.editReceipt === undefined
            ? undefined
            : assertEditBatchReceipt(exact.editReceipt);
        const single = batch === undefined && exact.receipt !== undefined
            ? assertEditReceipt(exact.receipt)
            : undefined;
        const batchSize = batch === undefined
            ? undefined
            : "disposition" in batch
                ? batch.superseded.length
                : batch.effects.length;
        if (batchSize !== undefined && batchSize !== pending.length) {
            throw new InvalidOperationResultError(
                `COPY/MOVE expected ${pending.length} receipt projections, got ${batchSize}.`,
            );
        }
        if (single !== undefined && pending.length !== 1) {
            throw new InvalidOperationResultError(
                `COPY/MOVE received one receipt for ${pending.length} resource effects.`,
            );
        }
        let effects: ResourceEffect[];
        if (batch !== undefined && "disposition" in batch) {
            const replacement = pending[0];
            if (replacement === undefined) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch has no resource effect.",
                );
            }
            if (pending.some(({ target, action }) =>
                target !== replacement.target || action !== replacement.action
            )) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch spans incompatible resource effects.",
                );
            }
            effects = [{
                ...replacement,
                receipt: projectEditReceipt(batch, 0),
            }];
        } else {
            effects = pending.map((effect, index): ResourceEffect => ({
                ...effect,
                ...(batch !== undefined
                    ? { receipt: projectEditReceipt(batch, index) }
                    : single !== undefined
                        ? { receipt: single }
                        : {}),
            }));
        }
        assertResourceEffects(effects);
        const {
            editReceipt: _editReceipt,
            receipt: _receipt,
            ...withoutInternalReceipts
        } = exact;
        return {
            ...withoutInternalReceipts,
            effects,
        };
    }

    // {§copy-move-observation} {§edit-result-copy-move-effects} — scoped
    // COPY/MOVE into an unscoped channel is a text materialization even when
    // CRUD creates the channel wholesale. Carry the receipt through synchronous
    // writes and proposals; the destination scheme owns reviewed output.
    static #withEditMaterialization(
        result: DispatchResult,
        receipt: EditBatchReceipt,
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status !== 200 && exact.status !== 201 && exact.status !== 202) return exact;
        const materialized = exact.editReceipt === undefined
            ? assertEditBatchReceipt(receipt)
            : assertEditBatchReceipt(exact.editReceipt);
        return {
            ...exact,
            editReceipt: materialized,
            ...(exact.status === 202
                ? {
                    attrs: {
                        ...(exact.attrs as Record<string, unknown> | undefined),
                        editReceipt: materialized,
                    },
                }
                : {}),
        };
    }

    #finalizeEffects(
        result: DispatchResult,
        selection: ResourceAddress,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        const routed = this.#withProposalRoute(result, selection);
        if (routed.status !== 202) return ResourceMutations.#appliedEffects(routed, pending);
        return {
            ...routed,
            attrs: {
                ...(routed.attrs as Record<string, unknown> | undefined),
                proposalEffects: pending,
            },
        };
    }

    static #effectsOf(result: DispatchResult): readonly ResourceEffect[] {
        return result.effects === undefined
            ? []
            : assertResourceEffects(result.effects);
    }

    static #withCombinedEffects(
        result: DispatchResult,
        ...additional: ReadonlyArray<readonly ResourceEffect[]>
    ): DispatchResult {
        const existing = ResourceMutations.#effectsOf(result);
        const effects = [...existing, ...additional.flat()];
        const { effects: _effects, ...withoutEffects } = result;
        return effects.length === 0
            ? withoutEffects
            : { ...withoutEffects, effects: assertResourceEffects(effects) };
    }

    static #settleProposalEffects(
        original: DispatchResult,
        settlement: ProposalSettlement,
    ): ProposalSettlement {
        const pending = (original.attrs as OrchestrationProposalAttrs | undefined)
            ?.proposalEffects;
        if (
            pending === undefined
            || settlement.resolution.decision !== "accept"
            || settlement.applied === undefined
            || settlement.applied.status >= 300
        ) {
            return settlement;
        }
        const projected = settlement.resolution.result ?? {};
        const aggregate = settlement.applied.editReceipt;
        const applied = ResourceMutations.#appliedEffects(
            {
                ...projected,
                status: settlement.applied.status,
                ...(aggregate === undefined ? {} : { editReceipt: aggregate }),
            },
            pending,
        );
        const {
            status: _status,
            body: _body,
            ...result
        } = applied;
        const {
            body: _resolutionBody,
            ...resolution
        } = settlement.resolution;
        return {
            ...settlement,
            resolution: {
                ...resolution,
                result,
            },
        };
    }

    #recordEditSettlement(
        statement: PlurnkStatement,
        settlement: ProposalSettlement,
    ): void {
        if (statement.op !== "EDIT") return;
        const prepared = this.#preparedEdits.get(statement);
        if (prepared === undefined || !prepared.first) {
            throw new InvalidOperationResultError(
                "An EDIT proposal settled without its prepared batch owner.",
            );
        }
        const { resolution, applied } = settlement;
        if (
            resolution.decision !== "accept"
            || applied === undefined
            || applied.status >= 300
        ) {
            prepared.batch.aggregate = undefined;
            return;
        }
        if (applied.editReceipt === null) {
            prepared.batch.aggregate = undefined;
            return;
        }
        if (applied.editReceipt !== undefined) {
            prepared.batch.aggregate = assertEditBatchReceipt(applied.editReceipt);
            return;
        }
        if (resolution.body !== undefined) prepared.batch.aggregate = undefined;
    }

    static #settlementEffects(settlement: ProposalSettlement): readonly ResourceEffect[] {
        const effects = (settlement.resolution.result as Record<string, unknown> | undefined)
            ?.effects;
        return effects === undefined ? [] : assertResourceEffects(effects);
    }

    static #withSettlementEffects(
        settlement: ProposalSettlement,
        effects: readonly ResourceEffect[],
    ): ProposalSettlement {
        const projected = (settlement.resolution.result ?? {}) as Record<string, unknown>;
        const { effects: _effects, ...withoutEffects } = projected;
        const result = effects.length === 0
            ? withoutEffects
            : {
                ...withoutEffects,
                effects: assertResourceEffects(effects),
            };
        return {
            ...settlement,
            resolution: {
                ...settlement.resolution,
                result,
            },
        };
    }

    #sameChannel(
        left: ResourceAddress,
        right: ResourceAddress,
    ): boolean {
        return left.scheme === right.scheme
            && left.identityPathname === right.identityPathname
            && left.channel === right.channel;
    }

    #withProposalRoute(
        result: DispatchResult,
        selection: ResourceAddress,
    ): DispatchResult {
        if (result.status !== 202) return result;
        return {
            ...result,
            attrs: {
                ...(result.attrs as Record<string, unknown> | undefined),
                proposalScheme: selection.scheme,
                proposalTarget: {
                    scheme: selection.scheme,
                    pathname: selection.identityPathname,
                },
            },
        };
    }

    async #invokeEditBatch(
        selection: ResolvedResourceSelection,
        edits: ReadonlyArray<{
            readonly marker: LineMarker;
            readonly body: string;
            readonly position: EditStatement["position"];
        }>,
        ctx: PlurnkSchemeContext,
        precondition: LineAnchorPrecondition | null = null,
    ): Promise<DispatchResult> {
        const handler = this.#schemes.get(selection.scheme, ctx.workspaceId) as SchemeHandler | undefined;
        if (typeof handler?.editBatch !== "function") {
            return ResourceMutations.#failure(
                "operation-not-implemented",
                501,
                `Scheme '${selection.scheme}' does not implement EDIT batches.`,
                {},
                {
                    scheme: selection.scheme,
                    operation: "EDIT",
                    retryable: false,
                },
            );
        }
        const statements: ResolvedEditStatement[] = edits.map(({ marker, body, position }) => ({
            op: "EDIT",
            suffix: "",
            annotation: null,
            signal: null,
            target: selection.target,
            lineMarker: marker,
            body,
            position,
        }));
        const addressedScheme = selection.target.kind === "url"
            ? selection.target.scheme
            : selection.scheme;
        try {
            const result = Results.assert(await handler.editBatch(
                statements,
                new SchemeCtxImpl(
                    ctx,
                    addressedScheme,
                    selection.manifest,
                    this.#liveSubscriptions,
                    {
                        publishedChannel: selection.channel,
                        editPrecondition: precondition,
                    },
                ),
            ));
            return this.#withProposalRoute(result, selection);
        } catch (err) {
            if (err instanceof InvalidOperationResultError) throw err;
            console.error(
                `Scheme '${selection.scheme}' COPY/MOVE edit threw outside its operation result contract:`,
                err,
            );
            return ResourceMutations.#failure(
                "scheme-handler-threw",
                500,
                `The '${selection.scheme}' scheme did not produce a COPY/MOVE edit result.`,
                {},
                {
                    stage: "scheme-dispatch",
                    scheme: selection.scheme,
                    operation: "EDIT",
                },
            );
        }
    }

    async #writeDestination(
        statement: CopyStatement | MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const existingResult = await this.#readEntry(
            destination.scheme,
            destination.pathname,
            ctx,
        );
        if (existingResult.status >= 400 && existingResult.status !== 404) {
            return existingResult;
        }
        const existing = existingResult.status === 200
            ? existingResult.entry
            : null;
        if (existingResult.status === 200 && existing === null) {
            throw new InvalidOperationResultError(
                `The '${destination.scheme}' scheme returned 200 without a destination entry.`,
            );
        }
        const destinationChannel = existing?.channels[destination.channel];
        const expectedMimetype = destinationChannel?.mimetype
            ?? await PathMimetype.resolveEntryMimetype(
                destination.pathname,
                destination.manifest.channels[destination.channel] ?? source.mimetype,
                ctx.mimetypes,
            );
        if (source.mimetype !== expectedMimetype) {
            return ResourceMutations.#failure(
                "mimetype-mismatch",
                415,
                `COPY or MOVE cannot write '${source.mimetype}' into a '${expectedMimetype}' channel.`,
                {},
                {
                    channel: destination.channel,
                    sourceMimetype: source.mimetype,
                    destinationMimetype: expectedMimetype,
                    retryable: false,
                },
            );
        }

        const destinationEffect = this.#pendingEffect(
            destination,
            destinationChannel === undefined ? "create" : "update",
        );
        if (destination.lineMarker !== null) {
            if (destinationChannel === undefined) {
                return ResourceMutations.#failure(
                    "destination-region-not-found",
                    404,
                    `A destination region requires an existing #${destination.channel} channel.`,
                    {},
                    {
                        destination: this.#resourceAddress(destination),
                        retryable: false,
                    },
                );
            }
            if (await MimetypeBinary.isBinaryMimetype(destinationChannel.mimetype, ctx.mimetypes)) {
                return ResourceMutations.#failure(
                    "binary-region-unsupported",
                    415,
                    `Channel #${destination.channel} is binary and cannot receive a textual region.`,
                    {},
                    {
                        channel: destination.channel,
                        mimetype: destinationChannel.mimetype,
                        retryable: false,
                    },
                );
            }
            const resolvedMarker = this.#resolveResourceLineMarker(
                destination,
                destinationChannel.content,
                statement.op,
            );
            if ("result" in resolvedMarker) return resolvedMarker.result;
            const edited = await this.#invokeEditBatch(
                resolvedMarker.selection,
                [{
                    marker: resolvedMarker.selection.lineMarker!,
                    body: source.content,
                    position: statement.position,
                }],
                ctx,
                resolvedMarker.precondition,
            );
            return this.#finalizeEffects(edited, resolvedMarker.selection, [destinationEffect]);
        }

        if (
            destinationChannel !== undefined
            && destinationChannel.content !== source.content
        ) {
            return ResourceMutations.#failure(
                "copy-destination-exists",
                409,
                `COPY or MOVE destination ${this.#resourceAddress(destination)} already contains different content.`,
                {},
                {
                    destination: this.#resourceAddress(destination),
                    retryable: false,
                },
            );
        }
        if (destinationChannel !== undefined) return { status: 304 };

        const channels = {
            ...(existing?.channels ?? {}),
            [destination.channel]: {
                content: source.content,
                mimetype: source.mimetype,
            },
        };
        const written = await this.#writeEntry(
            destination.scheme,
            destination.pathname,
            { channels },
            ctx,
        );
        const exactWritten = Results.assert(written);
        const parseIssues = exactWritten.status === 200 || exactWritten.status === 201
            ? await new DbProjectionCaps(ctx).parseIssues(source.content, source.mimetype)
            : undefined;
        const materialized = source.lineMarker === null
            || (exactWritten.status !== 200 && exactWritten.status !== 201 && exactWritten.status !== 202)
            ? exactWritten
            : ResourceMutations.#withEditMaterialization(
                exactWritten,
                editReceipt(
                    "",
                    source.content,
                    [{
                        marker: { marks: [1, -1] },
                        body: source.content,
                    }],
                    parseIssues,
                ),
            );
        return this.#finalizeEffects(
            materialized,
            destination,
            [destinationEffect],
        );
    }

    async #copyOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: CopyStatement;
        source: ResourceSelection;
        destination: ResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#resolveResourceSelection(source, ctx);
        if (ResourceMutations.#isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#resolveResourceSelection(destination, ctx);
        if (ResourceMutations.#isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selectSource(resolvedSource, ctx, "COPY");
        if (ResourceMutations.#isDispatchResult(selected)) return selected;
        const result = await this.#writeDestination(statement, selected, resolvedDestination, ctx);
        return ResourceMutations.#prependScopeNormalizations(result, selected.scopeNormalizations);
    }

    #deferredMoveSource(
        source: ResolvedResourceSelection,
        destination: ResourceAddress,
        lineAnchorPrecondition: LineAnchorPrecondition | null,
    ): DeferredMoveSource {
        return {
            target: source.target,
            lineMarker: source.lineMarker,
            scheme: source.scheme,
            pathname: source.pathname,
            channel: source.channel,
            destination: this.#resourceAddress(destination),
            lineAnchorPrecondition,
        };
    }

    #moveFailureAfterDestination(
        result: DispatchResult,
        destination: string,
        destinationEffects: readonly ResourceEffect[],
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status < 400) {
            throw new InvalidOperationResultError(
                "A successful MOVE source result was classified as a partial failure.",
            );
        }
        if (exact.problem === undefined) {
            throw new InvalidOperationResultError(
                "A failed MOVE source mutation has no Problem Details.",
            );
        }
        const failed = Results.assert({
            ...exact,
            problem: {
                ...exact.problem,
                operation: "MOVE",
                destinationWritten: true,
                destination,
            },
        });
        return ResourceMutations.#withCombinedEffects(failed, destinationEffects);
    }

    async #removeMoveSource(
        statement: MoveStatement,
        source: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
        lineAnchorPrecondition: LineAnchorPrecondition | null = null,
    ): Promise<DispatchResult> {
        const effect = this.#pendingEffect(
            source,
            source.lineMarker === null ? "delete" : "update",
        );
        if (source.lineMarker === null) {
            const deleted = await this.#deleteChannel(
                source.scheme,
                source.pathname,
                source.channel,
                ctx,
            );
            return this.#finalizeEffects(Results.assert(deleted), source, [effect]);
        }
        const edited = await this.#invokeEditBatch(
            source,
            [{
                marker: source.lineMarker,
                body: "",
                position: statement.position,
            }],
            ctx,
            lineAnchorPrecondition,
        );
        return this.#finalizeEffects(edited, source, [effect]);
    }

    async #moveWithinChannel(
        statement: MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (source.lineMarker === null) {
            if (destination.lineMarker !== null) {
                return ResourceMutations.#failure(
                    "move-region-overlap",
                    409,
                    "MOVE cannot insert a whole channel into itself and then remove that channel.",
                    {},
                    {
                        source: this.#resourceAddress(source),
                        destination: this.#resourceAddress(destination),
                        retryable: false,
                    },
                );
            }
            return this.#writeDestination(statement, source, destination, ctx);
        }
        if (destination.lineMarker === null) {
            return this.#writeDestination(statement, source, destination, ctx);
        }
        const resolvedDestination = this.#resolveResourceLineMarker(
            destination,
            source.completeContent,
            "MOVE",
        );
        if ("result" in resolvedDestination) return resolvedDestination.result;
        const precondition = ResourceMutations.#mergeLineAnchorPreconditions(
            source.lineAnchorPrecondition,
            resolvedDestination.precondition,
        );
        const moved = await this.#invokeEditBatch(
            resolvedDestination.selection,
            [
                {
                    marker: resolvedDestination.selection.lineMarker!,
                    body: source.content,
                    position: statement.position,
                },
                {
                    marker: source.lineMarker,
                    body: "",
                    position: statement.position,
                },
            ],
            ctx,
            precondition,
        );
        const effect = this.#pendingEffect(resolvedDestination.selection, "update");
        return this.#finalizeEffects(moved, resolvedDestination.selection, [effect, effect]);
    }

    async #moveOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: MoveStatement;
        source: ResourceSelection;
        destination: ResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#resolveResourceSelection(source, ctx);
        if (ResourceMutations.#isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#resolveResourceSelection(destination, ctx);
        if (ResourceMutations.#isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selectSource(resolvedSource, ctx, "MOVE");
        if (ResourceMutations.#isDispatchResult(selected)) return selected;

        if (this.#sameChannel(resolvedSource, resolvedDestination)) {
            const result = await this.#moveWithinChannel(
                statement,
                selected,
                resolvedDestination,
                ctx,
            );
            return resolvedDestination.lineMarker === null
                ? ResourceMutations.#prependScopeNormalizations(result, selected.scopeNormalizations)
                : result;
        }

        const destinationResult = ResourceMutations.#prependScopeNormalizations(
            await this.#writeDestination(
                statement,
                selected,
                resolvedDestination,
                ctx,
            ),
            selected.scopeNormalizations,
        );
        if (destinationResult.status >= 400) return destinationResult;
        const destinationAddress = this.#resourceAddress(resolvedDestination);
        const destinationEffects = ResourceMutations.#effectsOf(destinationResult);
        if (destinationResult.status === 202) {
            return {
                ...destinationResult,
                attrs: {
                    ...(destinationResult.attrs as Record<string, unknown> | undefined),
                    moveSource: this.#deferredMoveSource(
                        selected,
                        resolvedDestination,
                        selected.lineAnchorPrecondition,
                    ),
                },
            };
        }

        const sourceResult = await this.#removeMoveSource(
            statement,
            selected,
            ctx,
            selected.lineAnchorPrecondition,
        );
        if (sourceResult.status === 202) {
            return {
                ...sourceResult,
                ...(destinationResult.scopeNormalizations === undefined
                    ? {}
                    : { scopeNormalizations: destinationResult.scopeNormalizations }),
                attrs: {
                    ...(sourceResult.attrs as Record<string, unknown> | undefined),
                    moveDestinationWritten: destinationAddress,
                    moveDestinationEffects: destinationEffects,
                },
            };
        }
        if (sourceResult.status >= 400) {
            return this.#moveFailureAfterDestination(
                destinationResult.scopeNormalizations === undefined
                    ? sourceResult
                    : Results.assert({
                        ...sourceResult,
                        scopeNormalizations: destinationResult.scopeNormalizations,
                    }),
                destinationAddress,
                destinationEffects,
            );
        }
        const base = destinationResult.status === 304
            ? { ...destinationResult, status: 200 }
            : destinationResult;
        return ResourceMutations.#withCombinedEffects(
            base,
            ResourceMutations.#effectsOf(sourceResult),
        );
    }

    async #settleMoveProposal({
        statement,
        result,
        settlement,
        ctx,
        ids,
    }: {
        statement: PlurnkStatement;
        result: DispatchResult;
        settlement: ProposalSettlement;
        ctx: PlurnkSchemeContext;
        ids: {
            workspaceId: number;
            workerId: number;
            loopId: number;
            turnId: number;
        };
    }): Promise<ProposalSettlement> {
        if (statement.op !== "MOVE") return settlement;
        const attrs = result.attrs as OrchestrationProposalAttrs | undefined;
        const destinationWritten = attrs?.moveDestinationWritten;
        if (destinationWritten !== undefined) {
            const destinationEffects = attrs?.moveDestinationEffects === undefined
                ? []
                : assertResourceEffects(attrs.moveDestinationEffects);
            if (settlement.resolution.decision !== "accept") {
                const decision = settlement.resolution.decision;
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        ResourceMutations.#failure(
                            "move-source-not-applied",
                            decision === "cancel" ? 499 : 409,
                            `The MOVE destination was written, but source removal was ${decision === "cancel" ? "cancelled" : "rejected"}.`,
                            {},
                            {
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied === undefined) {
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        ResourceMutations.#failure(
                            "proposal-apply-missing",
                            500,
                            "The source scheme accepted its MOVE proposal without applying the source mutation.",
                            {},
                            {
                                stage: "proposal-application",
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied.status >= 400) {
                return {
                    resolution: settlement.resolution,
                    applied: this.#moveFailureAfterDestination(
                        settlement.applied,
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            return ResourceMutations.#withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...ResourceMutations.#settlementEffects(settlement),
                ],
            );
        }

        const deferred = attrs?.moveSource;
        if (
            deferred === undefined
            || settlement.resolution.decision !== "accept"
            || (settlement.applied?.status ?? 200) >= 400
        ) {
            return settlement;
        }
        if (settlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: ResourceMutations.#failure(
                    "proposal-apply-missing",
                    500,
                    "The destination scheme accepted its MOVE proposal without applying the destination mutation.",
                    {},
                    {
                        stage: "proposal-application",
                        retryable: false,
                    },
                ),
            };
        }
        const destinationEffects = ResourceMutations.#settlementEffects(settlement);

        const resolvedSource = await this.#resolveResourceSelection(
            {
                target: deferred.target,
                lineMarker: deferred.lineMarker,
            },
            ctx,
        );
        if (ResourceMutations.#isDispatchResult(resolvedSource)) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    resolvedSource,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (
            resolvedSource.scheme !== deferred.scheme
            || resolvedSource.pathname !== deferred.pathname
            || resolvedSource.channel !== deferred.channel
        ) {
            throw new InvalidOperationResultError(
                "A deferred MOVE source no longer resolves to its recorded identity.",
            );
        }

        const removed = await this.#removeMoveSource(
            statement,
            {
                ...resolvedSource,
                lineMarker: resolvedSource.lineMarker as LineMarker | null,
            },
            ctx,
            deferred.lineAnchorPrecondition,
        );
        if (removed.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    removed,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (removed.status !== 202) {
            return ResourceMutations.#withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...ResourceMutations.#effectsOf(removed),
                ],
            );
        }

        const initialSourceSettlement = await this.#applyProposal(
            statement,
            removed,
            { decision: "accept" },
            ids,
        );
        const sourceSettlement = ResourceMutations.#settleProposalEffects(
            removed,
            initialSourceSettlement,
        );
        if (sourceSettlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    ResourceMutations.#failure(
                        "proposal-apply-missing",
                        500,
                        "The source scheme accepted its MOVE proposal without applying the source mutation.",
                        {},
                        {
                            stage: "proposal-application",
                            retryable: false,
                        },
                    ),
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (sourceSettlement.applied.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: this.#moveFailureAfterDestination(
                    sourceSettlement.applied,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        return ResourceMutations.#withSettlementEffects(
            settlement,
            [
                ...destinationEffects,
                ...ResourceMutations.#settlementEffects(sourceSettlement),
            ],
        );
    }

    async settleProposal({
        statement,
        result,
        settlement,
        ctx,
        ids,
    }: {
        statement: PlurnkStatement;
        result: DispatchResult;
        settlement: ProposalSettlement;
        ctx: PlurnkSchemeContext;
        ids: ProposalIds;
    }): Promise<ProposalSettlement> {
        const withEffects = ResourceMutations.#settleProposalEffects(result, settlement);
        const effective = await this.#settleMoveProposal({
            statement,
            result,
            settlement: withEffects,
            ctx,
            ids,
        });
        this.#recordEditSettlement(statement, effective);
        return effective;
    }
}
