// `<L>` line-marker slicing + structural edits — single source of truth is
// @plurnk/plurnk-schemes (keystone PR-1). Local OO facade over the daughter's
// functions; call sites stay `LineMarkerOps.sliceLines(...)`. Types re-exported.
//
// `<L>` semantics (plurnk.md §`<L>`): <N> position, <N,M> range, <0> prepend
// sentinel, <-1> append sentinel, <1,-1> whole content.
import {
    sliceLines as _sliceLines,
    sliceJsonItems as _sliceJsonItems,
    applyJsonItemEdit as _applyJsonItemEdit,
    sliceLinesRaw as _sliceLinesRaw,
    applyLineMarkerEdit as _applyLineMarkerEdit,
} from "@plurnk/plurnk-schemes";
import type { SliceResult, JsonSliceResult, LineEditResult as EditResult } from "@plurnk/plurnk-schemes";
import type { LineMarker } from "@plurnk/plurnk-grammar";

export type { SliceResult, JsonSliceResult, EditResult };

export default class LineMarkerOps {
    static sliceLines(content: string, marker: LineMarker): SliceResult { return _sliceLines(content, marker); }
    static sliceJsonItems(content: string, marker: LineMarker): JsonSliceResult { return _sliceJsonItems(content, marker); }
    static applyJsonItemEdit(content: string, marker: LineMarker, body: string): EditResult { return _applyJsonItemEdit(content, marker, body); }
    static sliceLinesRaw(content: string, marker: LineMarker): SliceResult { return _sliceLinesRaw(content, marker); }
    static applyLineMarkerEdit(content: string, marker: LineMarker, body: string): EditResult { return _applyLineMarkerEdit(content, marker, body); }
}
