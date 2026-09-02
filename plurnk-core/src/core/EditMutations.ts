import { type EditStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ResolvedEditStatement, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import { assertEditBatchReceipt, EditCollision, LineAnchors, type LineAnchorCheck, type LineAnchorPrecondition } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import Results from "./results.ts";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { DispatchResult, EditPreparationContext, PreparedEditBatch, EditMergeFact, PreparedEdit, RunOperation } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";

// EDIT preparation and settlement ({§edit-batch-merges}): anchors, batches, merge facts, and the prepared-edit registry.
export default class EditMutations {
    readonly #schemes: SchemeRegistry;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #run: RunOperation;
    readonly #checkWritable: (statement: PlurnkStatement, origin: WriterTier, workerId: number) => DispatchResult | null;
    readonly #checkCapabilities: (statement: PlurnkStatement, workspaceId: number, loopId: number, workerId: number) => Promise<DispatchResult | null>;
    readonly #editTargetIdentity: (
        statement: EditStatement,
        workspaceId: number,
        workerId: number,
    ) => Promise<{ readonly key: string; readonly identity: string | null }>;
    readonly #resolveDataEntryAddress: EntryAddressBinding["resolve"];
    readonly #preparedEdits = new WeakMap<EditStatement, PreparedEdit>();


    constructor({ schemes, liveSubscriptions, run, checkWritable, checkCapabilities, editTargetIdentity, resolveDataEntryAddress }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        run: RunOperation;
        checkWritable: (statement: PlurnkStatement, origin: WriterTier, workerId: number) => DispatchResult | null;
        checkCapabilities: (statement: PlurnkStatement, workspaceId: number, loopId: number, workerId: number) => Promise<DispatchResult | null>;
        editTargetIdentity: (
        statement: EditStatement,
        workspaceId: number,
        workerId: number,
    ) => Promise<{ readonly key: string; readonly identity: string | null }>;
        resolveDataEntryAddress: EntryAddressBinding["resolve"];
    }) {
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#run = run;
        this.#checkWritable = checkWritable;
        this.#checkCapabilities = checkCapabilities;
        this.#editTargetIdentity = editTargetIdentity;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
    }

    async resolveEditAnchors(
        statements: readonly EditStatement[],
        identity: string | null,
        schemeName: string,
        manifest: SchemeManifest,
        ctx: PlurnkSchemeContext,
    ): Promise<{
        readonly statements: readonly ResolvedEditStatement[];
        readonly precondition: LineAnchorPrecondition | null;
        readonly prefixFacts: ReadonlyMap<EditStatement, EditMergeFact>;
    } | {
        readonly result: DispatchResult;
        readonly failedStatement: EditStatement | null;
    }> {
        const anchored = statements.filter(({ lineMarker }) => LineAnchors.hasAnchor(lineMarker));
        // {§edit-batch-merges} — a body that looks like a pasted READ rendering needs the current
        // anchors to be verified, so it takes the anchored path even without an anchor of its own.
        const looksRendered = ({ body }: EditStatement): boolean => {
            const rows = (body ?? "").split("\n").filter((row) => row.length > 0);
            return rows.length > 0 && rows.every((row) => LineAnchors.isAnchoredLine(row));
        };
        const rendered = statements.some(looksRendered)
            && manifest.textEditScopes === true && manifest.writableBy.includes("model");
        if (anchored.length === 0 && !rendered) {
            return { statements: statements as readonly ResolvedEditStatement[], precondition: null, prefixFacts: new Map() };
        }
        if (manifest.textEditScopes !== true || !manifest.writableBy.includes("model")) {
            return {
                result: MutationEffects.failure(
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
                failedStatement: null,
            };
        }
        if (identity === null) {
            return {
                result: MutationEffects.failure(
                    "edit-target-required",
                    400,
                    "A line-anchored EDIT requires a target resource.",
                    {},
                    { recovery: "Provide the target that rendered the line anchor.", retryable: false },
                ),
                failedStatement: null,
            };
        }

        const first = statements[0];
        if (first === undefined) return { statements: [], precondition: null, prefixFacts: new Map() };
        const current = await this.#run(schemeName, {
            op: "READ",
            delimiter: first.delimiter,
            annotation: null,
            target: first.target,
            metadata: first.metadata,
            lineMarker: { marks: [1, -1] },
            body: null,
            position: first.position,
        }, ctx);
        if (current.status === 204 || current.status === 404) {
            return { result: EditCollision.result(identity), failedStatement: null };
        }
        if (current.status >= 300) {
            return {
                result: MutationEffects.failure(
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
                failedStatement: null,
            };
        }
        if (current.status !== 200) {
            return { result: EditCollision.result(identity), failedStatement: null };
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
        // {§edit-batch-receipt} — every anchor is resolved before any verdict, so a collision
        // names each anchor that no longer resolves, not just the first (#428).
        const stale: Array<{ anchor: string; kind: "stale" | "ambiguous"; lines?: readonly number[] }> = [];
        // {§edit-batch-merges} — a body whose every line carries this resource's own rendered
        // `@xxxxx L:` prefix, hash-verified at its ordinal against the current anchors, is the
        // READ rendering pasted back: the prefixes are stripped and the row says so. A look-alike
        // that does not verify is content and is written as authored, with the fact reported.
        const prefixFacts = new Map<EditStatement, EditMergeFact>();
        // A paste from an older READ verifies against the anchors that READ actually published
        // (this worker's log rows for the same identity), so a stale paste is still a paste.
        type PublishedRead = { readonly startLine: number; readonly anchors: readonly string[] };
        let publishedReads: PublishedRead[] | null = null;
        const publishedAnchors = async (): Promise<PublishedRead[]> => {
            if (publishedReads !== null) return publishedReads;
            const rows = await ctx.db.engine_render_log.all<{ op: string; status_rx: number; rx: string | null }>({ worker_id: ctx.workerId });
            const reads: PublishedRead[] = [];
            for (const row of rows) {
                if (row.op !== "READ" || row.status_rx !== 200 || typeof row.rx !== "string") continue;
                let parsed: { lineAnchorIdentity?: unknown; lineAnchors?: unknown; startLine?: unknown };
                try { parsed = JSON.parse(row.rx) as typeof parsed; } catch { continue; }
                if (parsed.lineAnchorIdentity !== lineAnchorIdentity || !Array.isArray(parsed.lineAnchors)) continue;
                reads.push({ startLine: typeof parsed.startLine === "number" ? parsed.startLine : 1, anchors: parsed.lineAnchors as string[] });
            }
            publishedReads = reads;
            return reads;
        };
        const stripRendered = async (statement: EditStatement): Promise<EditStatement> => {
            const body = statement.body;
            if (typeof body !== "string" || body.length === 0) return statement;
            const rows = body.split("\n");
            const filled = rows.filter((row) => row.length > 0);
            if (filled.length === 0 || !filled.every((row) => LineAnchors.isAnchoredLine(row))) return statement;
            const pasted = filled.map((row) => { const match = /^(@[0-9A-Za-z]{5}) +(\d+):/.exec(row)!; return { hash: match[1]!, line: Number(match[2]) }; });
            const verifies = (anchors: readonly string[], startLine: number): boolean =>
                pasted.every(({ hash, line }) => anchors[line - startLine] === hash);
            const current = verifies(lineAnchors as readonly string[], 1);
            const source = current ? "current" : (await publishedAnchors()).some(({ anchors, startLine }) => verifies(anchors, startLine)) ? "log" : null;
            if (source === null) {
                prefixFacts.set(statement, { rule: "rendered-prefix-unverified", lines: filled.length });
                return statement;
            }
            prefixFacts.set(statement, { rule: "rendered-prefix-stripped", lines: filled.length, source });
            // A rendered row per line: a blank last line keeps its terminator so the paste
            // reproduces exactly the lines it rendered.
            const stripped = rows.map((row) => row.replace(/^@[0-9A-Za-z]{5} +\d+:/, ""));
            return { ...statement, body: stripped.join("\n") + (stripped.length > 1 && stripped.at(-1) === "" ? "\n" : "") };
        };
        for (const authored of statements) {
            const statement = await stripRendered(authored);
            if (statement.lineMarker === null || !LineAnchors.hasAnchor(statement.lineMarker)) {
                resolved.push(statement as ResolvedEditStatement);
                continue;
            }
            const resolution = LineAnchors.resolve(lineAnchors, statement.lineMarker);
            if (!resolution.ok) {
                const { anchor, kind } = resolution.failure;
                const invalid = kind === "invalid";
                if (!invalid) {
                    stale.push({ anchor, kind, ...("matches" in resolution.failure ? { lines: resolution.failure.matches } : {}) });
                    continue;
                }
                return {
                    result: MutationEffects.failure(
                        "line-anchor-invalid",
                        400,
                        LineAnchors.invalidCoordinateDetail,
                        {},
                        {
                            anchor,
                            target: identity,
                            recovery: LineAnchors.invalidCoordinateRecovery,
                            retryable: false,
                        },
                    ),
                    failedStatement: authored,
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
        if (stale.length > 0) {
            const named = stale.map((s) => s.kind === "ambiguous" ? `${s.anchor} (matches lines ${(s.lines ?? []).join(", ")})` : s.anchor).join(", ");
            return {
                result: EditCollision.result(lineAnchorIdentity, {}, {
                    staleAnchors: stale,
                    editCount: statements.length,
                    applied: 0,
                    recovery: `${named} no longer resolve${stale.length === 1 ? "s" : ""} — the line moved or changed since the READ that rendered ${stale.length === 1 ? "it" : "them"}; 0 of ${statements.length} edits in this batch were applied. READ the target again before selecting current coordinates.`,
                }),
                failedStatement: null,
            };
        }
        const uniqueChecks = [...new Map(checks.map((check) => [`${check.anchor}:${check.line}`, check])).values()];
        return {
            statements: resolved,
            // A strip-only batch authored no anchor and so carries no compare-and-swap precondition.
            precondition: uniqueChecks.length === 0 ? null : { identity: lineAnchorIdentity, checks: uniqueChecks },
            prefixFacts,
        };
    }


    async prepareEditBatches(
        statements: readonly EditStatement[],
        context: EditPreparationContext,
        schemeCtx: PlurnkSchemeContext,
    ): Promise<void> {
        const { workspaceId, loopId, origin } = context;
        const ctx = schemeCtx;
        const groups = new Map<string, { readonly identity: string | null; readonly statements: EditStatement[] }>();
        for (const statement of statements) {
            const { key, identity } = await this.#editTargetIdentity(statement, workspaceId, ctx.functionalityWorkerId);
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
            let projections: ReadonlyMap<EditStatement, DispatchResult> | null = null;
            let prefixFacts: ReadonlyMap<EditStatement, EditMergeFact> = new Map();
            let denial = group.map((statement) => this.#checkWritable(statement, origin, ctx.functionalityWorkerId)).find((result) => result !== null) ?? null;
            if (denial === null) {
                for (const statement of group) {
                    denial = await this.#checkCapabilities(statement, ctx.workspaceId, loopId, ctx.functionalityWorkerId);
                    if (denial !== null) break;
                }
            }
            if (denial !== null) {
                initial = denial;
            } else if (schemeName === null) {
                initial = MutationEffects.failure(
                    "target-required",
                    400,
                    "EDIT requires a target scheme.",
                    {},
                    { retryable: false },
                );
            } else {
                const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as SchemeHandler | undefined;
                const method = handler?.editBatch;
                const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
                if (handler === undefined || typeof method !== "function" || manifest?.category !== "data") {
                    initial = MutationEffects.failure(
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
                } else if (group.some(({ metadata }) => metadata !== null) && manifest.metadataModifier !== true) {
                    initial = MutationEffects.failure(
                        "scheme-metadata-unsupported",
                        400,
                        `Scheme '${schemeName}' does not accept the {metadata} modifier.`,
                        {},
                        { scheme: schemeName, operation: "EDIT", retryable: false },
                    );
                } else {
                    try {
                        const resolved = await this.resolveEditAnchors(
                            group,
                            preparedGroup.identity,
                            schemeName,
                            manifest,
                            schemeCtx,
                        );
                        if ("result" in resolved) {
                            initial = resolved.result;
                            if (resolved.failedStatement !== null) {
                                projections = new Map(group.map((statement) => [
                                    statement,
                                    statement === resolved.failedStatement
                                        ? resolved.result
                                        : MutationEffects.failure(
                                            "edit-batch-rejected",
                                            424,
                                            "This EDIT was not applied because another EDIT in the same resource batch was invalid.",
                                            {},
                                            {
                                                operation: "EDIT",
                                                target: preparedGroup.identity,
                                                retryable: false,
                                            },
                                        ),
                                ]));
                            }
                        } else {
                            prefixFacts = resolved.prefixFacts;
                            const addressedScheme = first.target?.kind === "url" ? first.target.scheme : schemeName;
                            const publishedChannel = first.target?.kind === "url"
                                ? first.target.fragment ?? manifest.defaultChannel
                                : manifest.defaultChannel;
                            if (first.target === null) {
                                throw new InvalidOperationResultError("An EDIT batch has no target.");
                            }
                            const binding = await this.#resolveDataEntryAddress({
                                target: first.target,
                                routedScheme: schemeName,
                                handler,
                                manifest,
                                ctx: schemeCtx,
                            });
                            if (binding.result !== null) {
                                initial = binding.result;
                            } else if (binding.address === null) {
                                initial = MutationEffects.failure(
                                    "entry-not-found",
                                    404,
                                    "The EDIT target could not be resolved.",
                                );
                            } else {
                                initial = Results.assert(await method.call(handler, resolved.statements, new SchemeCtxImpl(
                                    schemeCtx,
                                    addressedScheme ?? schemeName,
                                    manifest,
                                    this.#liveSubscriptions,
                                    {
                                        authority: binding.address.authority,
                                        ownerId: binding.address.ownerId,
                                        publishedChannel,
                                        editPrecondition: resolved.precondition,
                                    },
                                )));
                            }
                        }
                    } catch (err) {
                        if (err instanceof InvalidOperationResultError) throw err;
                        console.error(`Scheme '${schemeName}' EDIT batch threw outside its operation result contract:`, err);
                        initial = MutationEffects.failure(
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
            // {§edit-batch-merges} — the scheme's merge facts are keyed by authored index; a dropped
            // duplicate has no effect in the applied-edits receipt, so receipt indices re-align.
            const merges = initial.status < 400
                ? ((initial as { merges?: readonly (EditMergeFact & { readonly index: number })[] }).merges ?? [])
                : [];
            const DROPPING_RULES = new Set(["duplicate-of", "contained-relocated", "contained-already-applied"]);
            const droppedIndices = new Set(merges.filter(({ rule }) => DROPPING_RULES.has(rule)).map(({ index }) => index));
            let normalizationIndex = 0;
            for (const [index, statement] of group.entries()) {
                const dropped = droppedIndices.has(index);
                const ownsNormalization = statement.lineMarker?.marks.length === 3 && initial.status < 400 && !dropped;
                const own: EditMergeFact[] = merges.filter((merge) => merge.index === index).map(({ index: _index, ...fact }) => fact);
                const prefix = prefixFacts.get(statement);
                if (prefix !== undefined) own.push(prefix);
                this.#preparedEdits.set(statement, {
                    first: index === 0,
                    index,
                    normalizationIndex: ownsNormalization ? normalizationIndex++ : null,
                    projection: projections?.get(statement) ?? null,
                    batch,
                    receiptIndex: dropped ? null : index - [...droppedIndices].filter((d) => d < index).length,
                    merged: own,
                });
            }
        }
    }


    preparedEditResult(statement: EditStatement): Promise<DispatchResult> {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared === undefined) {
            throw new InvalidOperationResultError("EDIT reached dispatch without a prepared resource batch.");
        }
        return MutationEffects.projectPreparedEdit(prepared);
    }


    withMergeFacts(statement: EditStatement, result: DispatchResult): DispatchResult {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared === undefined || prepared.merged.length === 0) return result;
        return Results.assert({ ...result, merged: prepared.merged });
    }


    settleEdit(statement: EditStatement, result: DispatchResult): void {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared?.first !== true) return;
        const normalizations = prepared.batch.initial.scopeNormalizations;
        prepared.batch.settle(normalizations === undefined
            ? result
            : Results.assert({ ...result, scopeNormalizations: normalizations }));
    }


    recordEditSettlement(
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


    // The merge facts the preparation recorded for one statement, for its proposal settlement.
    mergeFacts(statement: EditStatement): PreparedEdit["merged"] {
        return this.#preparedEdits.get(statement)?.merged ?? [];
    }
}
