// `<L>` line-marker slicing + structural edits — single source of truth is
// @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the daughter's
// functions; call sites stay `LineMarkerOps.sliceLines(...)`. Types re-exported.
//
// `<L>` semantics (plurnk.md §`<L>`): <N> position, <N,M> range, <0> prepend
// sentinel, <-1> append sentinel, <1,-1> whole content.
import { Slicer } from "@plurnk/plurnk-schemes";
import type { SliceResult, JsonSliceResult, LineEditResult as EditResult } from "@plurnk/plurnk-schemes";
import type { LineMarker } from "@plurnk/plurnk-grammar";

export type { SliceResult, JsonSliceResult, EditResult };

export default class LineMarkerOps {
    static sliceLines(content: string, marker: LineMarker): SliceResult { return Slicer.lines(content, LineMarkerOps.#compat(marker)); }
    static sliceJsonItems(content: string, marker: LineMarker): JsonSliceResult { return Slicer.jsonItems(content, LineMarkerOps.#compat(marker)); }
    static applyJsonItemEdit(content: string, marker: LineMarker, body: string): EditResult { return Slicer.jsonItemEdit(content, LineMarkerOps.#compat(marker), body); } // structural JSON item edit; malformed JSON → 400 — §json-edit-structural-json-edit §json-edit-json-parse-fail-400
    static sliceLinesRaw(content: string, marker: LineMarker): SliceResult { return Slicer.linesRaw(content, LineMarkerOps.#compat(marker)); }
    static applyLineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult { return Slicer.lineMarkerEdit(content, LineMarkerOps.#compat(marker), body); }

    // grammar 0.49: the <L> parser carries raw numbers in `marks`; role-assignment is the
    // consumer's. We read the first mark as start and the second as end (<N,M> range), null for
    // a lone <N>. Used by the service's own range/threshold consumers (paginate, ~query top-K).
    static firstLast(marker: LineMarker): { first: number; last: number | null } {
        return { first: marker.marks[0], last: marker.marks.length > 1 ? marker.marks[1] : null };
    }

    // TEMPORARY (plurnk-schemes#19): the published Slicer (0.10) still reads {first,last};
    // adapt at this facade boundary until schemes adopts `marks`, then delete #compat and pass
    // the raw marker straight through.
    static #compat(marker: LineMarker): LineMarker {
        return LineMarkerOps.firstLast(marker) as unknown as LineMarker;
    }
}
