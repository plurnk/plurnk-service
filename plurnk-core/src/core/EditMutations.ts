import { type EditStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ResolvedEditStatement, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import { EditCollision, LineAnchors, type LineAnchorCheck, type LineAnchorPrecondition } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import Results from "./results.ts";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { DispatchResult, EditMergeFact, RunOperation } from "./mutation-types.ts";
import type EditSequence from "./EditSequence.ts";
import type { EditSnapshot } from "./EditSequence.ts";
import MutationEffects from "./MutationEffects.ts";

// {§edit-execution}: one authored EDIT owns one effect and one proposal.
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
    ) => Promise<string | null>;
    readonly #resolveDataEntryAddress: EntryAddressBinding["resolve"];
    readonly #preparedEdits = new WeakMap<EditStatement, {
        readonly merged: readonly EditMergeFact[];
        readonly snapshot?: EditSnapshot;
        readonly resolved?: ResolvedEditStatement;
        readonly sequence?: EditSequence;
    }>();


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
        ) => Promise<string | null>;
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

    async #resolveEditAnchors(
        authored: EditStatement,
        identity: string | null,
        schemeName: string,
        manifest: SchemeManifest,
        ctx: PlurnkSchemeContext,
        sequence?: EditSequence,
    ): Promise<{
        readonly statement: ResolvedEditStatement;
        readonly precondition: LineAnchorPrecondition | null;
        readonly prefixFact?: EditMergeFact;
        readonly snapshot?: EditSnapshot;
    } | {
        readonly result: DispatchResult;
    }> {
        const anchored = LineAnchors.hasAnchor(authored.lineMarker);
        // {§edit-batch-merges} — a body that looks like a pasted READ rendering needs the current
        // anchors to be verified, so it takes the anchored path even without an anchor of its own.
        const looksRendered = ({ body }: EditStatement): boolean => {
            const rows = (body ?? "").split("\n").filter((row) => row.length > 0);
            return rows.length > 0 && rows.every((row) => LineAnchors.isAnchoredLine(row));
        };
        const rendered = looksRendered(authored)
            && manifest.textEditScopes === true && manifest.writableBy.includes("model");
        const track = sequence !== undefined && manifest.textEditScopes === true && manifest.writableBy.includes("model");
        if (!anchored && !rendered && !track) {
            return { statement: authored as ResolvedEditStatement, precondition: null };
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
            };
        }

        const current = await this.#run(schemeName, {
            op: "READ",
            delimiter: authored.delimiter,
            annotation: null,
            target: authored.target,
            metadata: authored.metadata,
            lineMarker: { marks: [1, -1] },
            body: null,
            position: authored.position,
        }, ctx);
        if (current.status === 204 || current.status === 404) {
            sequence?.forget(identity);
            if (!anchored && !rendered) {
                return { statement: authored as ResolvedEditStatement, precondition: null };
            }
            return { result: EditCollision.result(identity) };
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

        let resolved: ResolvedEditStatement;
        const snapshot = sequence?.observe(lineAnchorIdentity, content);
        const resolve = (marker: NonNullable<EditStatement["lineMarker"]>) =>
            LineAnchors.resolve(lineAnchors, marker, snapshot?.anchors);
        const checks: LineAnchorCheck[] = [];
        // {§edit-batch-receipt} — diagnose all unresolved anchors, including both range endpoints.
        const unresolved = new Map<string, { anchor: string; kind: "missing" | "ambiguous"; lines?: readonly number[] }>();
        // {§edit-batch-merges} — a body whose every line carries this resource's own rendered
        // `@xxxxx L:` prefix, hash-verified at its ordinal against the current anchors, is the
        // READ rendering pasted back: the prefixes are stripped and the row says so. A look-alike
        // that does not verify is content and is written as authored, with the fact reported.
        let prefixFact: EditMergeFact | undefined;
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
                prefixFact = { rule: "rendered-prefix-unverified", lines: filled.length };
                return statement;
            }
            prefixFact = { rule: "rendered-prefix-stripped", lines: filled.length, source };
            // A rendered row per line: a blank last line keeps its terminator so the paste
            // reproduces exactly the lines it rendered.
            const stripped = rows.map((row) => row.replace(/^@[0-9A-Za-z]{5} +\d+:/, ""));
            return { ...statement, body: stripped.join("\n") + (stripped.length > 1 && stripped.at(-1) === "" ? "\n" : "") };
        };
        const statement = await stripRendered(authored);
        if (statement.lineMarker === null || !LineAnchors.hasAnchor(statement.lineMarker)) {
            resolved = statement as ResolvedEditStatement;
        } else {
            const resolution = resolve(statement.lineMarker);
            if (!resolution.ok) {
                if (resolution.failure.kind === "invalid") {
                    return {
                        result: MutationEffects.failure(
                            "line-anchor-invalid", 400, LineAnchors.invalidCoordinateDetail, {},
                            { anchor: resolution.failure.anchor, target: identity, recovery: LineAnchors.invalidCoordinateRecovery, retryable: false },
                        ),
                    };
                }
                for (const mark of statement.lineMarker.marks) {
                    if (typeof mark !== "string" || unresolved.has(mark)) continue;
                    const endpoint = resolve({ marks: [mark] });
                    if (endpoint.ok) continue;
                    if (endpoint.failure.kind === "invalid") {
                        throw new InvalidOperationResultError("A validated EDIT anchor became an invalid line coordinate.");
                    }
                    const { anchor, kind, matches } = endpoint.failure;
                    unresolved.set(anchor, { anchor, kind, ...(matches === undefined ? {} : { lines: matches }) });
                }
                return {
                    result: EditCollision.result(lineAnchorIdentity, {}, {
                        unresolvedAnchors: [...unresolved.values()],
                        editCount: 1,
                        applied: 0,
                        recovery: "0 of 1 edits applied. READ the target for current coordinates.",
                    }),
                };
            }
            for (const [index, anchor] of statement.lineMarker.marks.entries()) {
                if (typeof anchor !== "string") continue;
                const line = resolution.marker.marks[index];
                if (typeof line !== "number") {
                    throw new InvalidOperationResultError("An EDIT line anchor did not lower to a numeric line.");
                }
                // The owner validates current content, not the carried anchor's former neighborhood.
                checks.push({ anchor: lineAnchors[line - 1]!, line });
            }
            resolved = { ...statement, lineMarker: resolution.marker };
        }
        const uniqueChecks = [...new Map(checks.map((check) => [`${check.anchor}:${check.line}`, check])).values()];
        return {
            statement: resolved,
            // A strip-only EDIT authored no anchor and so carries no compare-and-swap precondition.
            precondition: uniqueChecks.length === 0 ? null : { identity: lineAnchorIdentity, checks: uniqueChecks },
            prefixFact,
            snapshot,
        };
    }


    async edit(
        statement: EditStatement,
        ctx: PlurnkSchemeContext,
        sequence?: EditSequence,
    ): Promise<DispatchResult> {
        const denial = this.#checkWritable(statement, ctx.writer, ctx.functionalityWorkerId)
            ?? await this.#checkCapabilities(statement, ctx.workspaceId, ctx.loopId, ctx.functionalityWorkerId);
        if (denial !== null) return denial;
        const schemeName = schemeNameOf(statement.target);
        if (schemeName === null || statement.target === null) {
            return MutationEffects.failure("target-required", 400, "EDIT requires a target scheme.", {}, { retryable: false });
        }
        const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as SchemeHandler | undefined;
        const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
        if (handler?.editBatch === undefined || manifest === undefined) {
            return MutationEffects.failure("operation-not-implemented", 501,
                `Scheme '${schemeName}' does not implement EDIT.`, {},
                { scheme: schemeName, operation: "EDIT", retryable: false });
        }
        if (statement.metadata !== null && manifest.metadataModifier !== true) {
            return MutationEffects.failure("scheme-metadata-unsupported", 400,
                `Scheme '${schemeName}' does not accept the {metadata} modifier.`, {},
                { scheme: schemeName, operation: "EDIT", retryable: false });
        }
        const identity = await this.#editTargetIdentity(statement, ctx.workspaceId, ctx.functionalityWorkerId);
        const resolved = await this.#resolveEditAnchors(statement, identity, schemeName, manifest, ctx, sequence);
        if ("result" in resolved) return resolved.result;
        const addressedScheme = statement.target.kind === "url" ? statement.target.scheme : schemeName;
        const publishedChannel = statement.target.kind === "url"
            ? statement.target.fragment ?? manifest.defaultChannel
            : manifest.defaultChannel;
        const binding = manifest.category !== "data" ? null : await this.#resolveDataEntryAddress({
            target: statement.target, routedScheme: schemeName, handler, manifest, ctx,
        });
        if (binding?.result !== null && binding?.result !== undefined) return binding.result;
        if (binding !== null && binding.address === null) {
            return MutationEffects.failure("entry-not-found", 404, "The EDIT target could not be resolved.");
        }
        const result = Results.assert(await handler.editBatch([resolved.statement], new SchemeCtxImpl(
            ctx,
            addressedScheme ?? schemeName,
            manifest,
            this.#liveSubscriptions,
            {
                authority: binding?.address?.authority ?? (statement.target.kind === "url" ? statement.target.hostname ?? "" : ""),
                ownerId: binding?.address?.ownerId ?? null,
                publishedChannel,
                editPrecondition: resolved.precondition,
            },
        )));
        const expectedNormalizations = statement.lineMarker?.marks.length === 3 ? 1 : 0;
        if (result.status < 400 && (result.scopeNormalizations?.length ?? 0) !== expectedNormalizations) {
            throw new InvalidOperationResultError(
                `EDIT normalized ${result.scopeNormalizations?.length ?? 0} scope(s), expected ${expectedNormalizations}.`,
            );
        }
        const merged = resolved.prefixFact === undefined ? [] : [resolved.prefixFact];
        this.#preparedEdits.set(statement, {
            merged,
            snapshot: resolved.snapshot,
            resolved: resolved.statement,
            sequence,
        });
        return this.withMergeFacts(statement, MutationEffects.projectEdit(result));
    }

    withMergeFacts(statement: EditStatement, result: DispatchResult): DispatchResult {
        const merged = this.mergeFacts(statement);
        return merged.length === 0 ? result : Results.assert({ ...result, merged });
    }

    settleEdit(statement: EditStatement, result: DispatchResult): void {
        const prepared = this.#preparedEdits.get(statement);
        if (prepared?.snapshot !== undefined && prepared.resolved !== undefined) {
            prepared.sequence?.settle(prepared.snapshot, prepared.resolved, result);
        }
    }

    mergeFacts(statement: EditStatement): readonly EditMergeFact[] {
        return this.#preparedEdits.get(statement)?.merged ?? [];
    }
}
