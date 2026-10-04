// `<L>` text-region slicing and editing - single source of truth is
// @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the plugin's
// functions; call sites stay `LineMarkerOps.sliceLines(...)`. Types re-exported.
//
// `<L>` semantics (plurnk.md §`<L>`): <N> line, <N,M> line range,
// <SL,SC,EL,EC> exact text region, <0> prepend sentinel, <-1> append
// sentinel, and <1,-1> whole content.
import { Slicer } from "@plurnk/plurnk-schemes";
import type {
    SliceResult,
    LineEditResult as EditResult,
    BatchEdit,
    PageResult,
    RangeUnit,
    TextReplacement,
    WindowResult,
} from "@plurnk/plurnk-schemes";
import type { LineMarker, RangeExtent } from "@plurnk/plurnk-contracts";

export type { SliceResult, EditResult };

export default class LineMarkerOps {
    // {§markerless-first-page} — a retrieval without a scope selects everything: `<1,-1>` in whatever unit the
    // projection counts. A fresh object each time; marks are owned by their statement.
    static whole(): LineMarker {
        return { marks: [1, -1] };
    }

    static sliceLines(content: string, marker: LineMarker): SliceResult { return Slicer.lines(content, marker); }
    static sliceLinesRaw(content: string, marker: LineMarker): SliceResult { return Slicer.linesRaw(content, marker); }
    static applyLineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult { return Slicer.lineMarkerEdit(content, marker, body); }
    static applyLineMarkerEditBatch(content: string, edits: readonly BatchEdit[]): EditResult { return Slicer.lineMarkerEditBatch(content, edits); }
    static textReplacement(content: string, marker: LineMarker, body: string): TextReplacement | { error: string } {
        return Slicer.textReplacement(content, marker, body);
    }
    // {§zero-width-column-one-insert} — normalize authored insertion bodies before scheme dispatch.
    static wholeLineBody(content: string, marker: LineMarker, body: string): string { return Slicer.wholeLineBody(content, marker, body); }
    static page<T>(
        items: readonly T[],
        marker: LineMarker,
        options: { readonly unit?: RangeUnit } = {},
    ): PageResult<T> { return Slicer.page(items, marker, options); }

    static coversAvailable(range: RangeExtent): boolean { return Slicer.coversAvailable(range); }
    static window(marker: LineMarker, total: number, unit: RangeUnit): WindowResult { return Slicer.window(marker, total, unit); }

}
