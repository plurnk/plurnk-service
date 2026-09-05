import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { EDIT_NOOP_DETAIL, EditCollision, LineAnchors, LineMarkerOps, editReceipt } from "../content/index.ts";
import type { LineAnchorPrecondition } from "../content/index.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import Results from "../core/results.ts";
import LogBody from "../core/LogBody.ts";
import LogVisibility from "../core/LogVisibility.ts";
import type { EditResult } from "./_entry-ops.ts";

export interface EditableLogRow {
    readonly id: number;
    readonly op: string | null;
    readonly attrs: string;
    readonly rx: string;
    readonly folded: string;
}

export default class LogEdits {
    static async apply(
        row: EditableLogRow,
        identity: string,
        statements: readonly ResolvedEditStatement[],
        precondition: LineAnchorPrecondition | null,
        ctx: PlurnkSchemeContext,
    ): Promise<EditResult> {
        LineAnchors.assertResolved(statements);
        const fields = { entryId: null, channel: null };
        if (row.op !== null || LogBody.actionlessKind(row) !== "reasoning") {
            return Results.failure("scheme:log", "immutable-entry", 403, "This log item is immutable.", fields) as EditResult;
        }
        if (statements.some(({ lineMarker }) => lineMarker === null)) {
            return Results.failure("scheme:log", "line-marker-required", 400,
                "EDIT of an existing log item requires a scope.", fields,
                { recovery: "Use <1,-1> for the complete body or select a narrower region.", retryable: false }) as EditResult;
        }
        const before = (JSON.parse(row.rx) as { content: string }).content;
        if (precondition !== null && !LineAnchors.satisfies(precondition, before)) {
            return EditCollision.result(identity, fields) as EditResult;
        }
        const edits = statements.map(({ lineMarker, body }) => ({ marker: lineMarker!, body: body ?? "" }));
        const applied = LineMarkerOps.applyLineMarkerEditBatch(before, edits);
        if (applied.status !== 200) return Results.assert({ ...applied, ...fields }) as EditResult;
        const after = applied.result!;
        if (after === before) return { status: 304, ...fields, detail: EDIT_NOOP_DETAIL };
        const landedEdits = applied.applied ?? edits;
        const replacements = landedEdits.map(({ marker, body }) => {
            const replacement = LineMarkerOps.textReplacement(before, marker, body);
            if ("error" in replacement) throw new Error(`An applied EDIT has invalid coordinates: ${replacement.error}`);
            return replacement;
        });
        const folded = LogVisibility.rebase(LogVisibility.parse(row.folded), before, after, replacements);
        if (ctx.weigh === undefined) throw new Error("Log EDIT requires content accounting.");
        const written = await ctx.db.log_edit_projection.get<{ id: number }>({
            id: row.id, turn_id: ctx.turnId, content: after, weight: ctx.weigh(after), expected_content: before,
            folded_before: row.folded, folded_after: LogVisibility.serialize(folded),
        });
        if (written === undefined) return EditCollision.result(identity, fields) as EditResult;
        return {
            status: 200, ...fields,
            editReceipt: editReceipt(before, after, landedEdits, undefined, identity),
            ...(applied.scopeNormalizations === undefined ? {} : { scopeNormalizations: applied.scopeNormalizations }),
            ...(applied.merges === undefined ? {} : { merges: applied.merges }),
        };
    }
}
