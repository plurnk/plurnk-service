// Shared exact-target READ projection for entry-bearing schemes, File, and Log.
// READ owns text coordinates only; FIND owns every aggregate or matcher selection.

import type { LineMarker, RangeExtent, TextRegion } from "@plurnk/plurnk-contracts";
import type { SchemeResultBase, ScopeNormalization } from "@plurnk/plurnk-schemes";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import LineMarkerOps from "./line-marker.ts";
import MimetypeBinary from "./mimetype-binary.ts";
import BodyPreview from "./body-preview.ts";
import LineSelection from "./line-selection.ts";

export interface ReadSliceResult extends SchemeResultBase {
    content: string | null;
    mimetype: string;
    startLine?: number | null;
    lineOrdinals?: readonly number[];
    region?: TextRegion;
    reason?: string;
    range?: RangeExtent;
    scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
}

export default class ReadResolve {
    static async resolve(opts: {
        content: string;
        mimetype: string;
        lineMarker: LineMarker | null;
        visibleLines?: readonly number[];
    }): Promise<ReadSliceResult> {
        const { content, mimetype, lineMarker, visibleLines } = opts;
        const preview = lineMarker === null
            ? BodyPreview.select(visibleLines === undefined ? content : LineSelection.retain(content, visibleLines).content).marker
            : null;
        const marker: LineMarker = lineMarker ?? (visibleLines === undefined || visibleLines.length === 0
            ? preview!
            : { marks: preview!.marks.map((mark, index) => {
                if (preview!.marks.length === 4 && index % 2 === 1) return mark;
                return visibleLines[Math.min(mark, visibleLines.length) - 1]!;
            }) as LineMarker["marks"] });
        const sliced = LineMarkerOps.sliceLines(content, marker);
        if (sliced.status === 416) {
            return {
                status: 416,
                content: null,
                mimetype,
                ...(sliced.problem === undefined ? {} : { problem: sliced.problem }),
                ...(sliced.problem?.detail === undefined ? {} : { reason: sliced.problem.detail }),
                ...(sliced.range === undefined ? {} : { range: sliced.range }),
            };
        }
        if (sliced.status !== 200) {
            throw new Error(`ReadResolve: text slicing returned unexpected status ${sliced.status}`);
        }
        const selectedMimetype = lineMarker === null
            ? mimetype
            : MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
        const unfilteredContent = lineMarker === null
            && sliced.range !== undefined
            && LineMarkerOps.coversAvailable(sliced.range)
            ? content
            : sliced.text ?? "";
        const selection = visibleLines === undefined ? undefined : LineSelection.retain(unfilteredContent, visibleLines, sliced.startLine ?? 1);
        const selectedContent = selection?.content ?? unfilteredContent;
        const startLine = selection?.ordinals[0] ?? sliced.startLine ?? null;
        const region = sliced.region === undefined || selectedContent === "" ? undefined : {
            ...sliced.region,
            ...(selection === undefined ? {} : {
                startLine: selection.ordinals[0]!,
                endLine: selection.ordinals.at(-1)!,
                ...(selection.ordinals[0] === sliced.region.startLine ? {} : { startColumn: 1 }),
                ...(selection.ordinals.at(-1) === sliced.region.endLine ? {} : {
                    endColumn: TextCoordinates.lineRegion(content, selection.ordinals.at(-1)!, selection.ordinals.at(-1)!)!.endColumn,
                }),
            }),
        };
        const range = sliced.range === undefined || selection === undefined ? sliced.range : {
            unit: sliced.range.unit,
            total: sliced.range.total,
            requested: sliced.range.requested,
            ...(selection.ordinals.length === 0 ? {} : { returned: [selection.ordinals[0]!, selection.ordinals.at(-1)!] as [number, number] }),
        };
        return {
            status: selectedContent === "" ? 204 : 200,
            content: selectedContent,
            mimetype: selectedMimetype,
            startLine: selectedContent === "" ? null : startLine,
            ...(selection === undefined ? {} : { lineOrdinals: selection.ordinals }),
            ...(region === undefined ? {} : { region }),
            ...(range === undefined ? {} : { range }),
            ...(sliced.scopeNormalizations === undefined
                ? {}
                : { scopeNormalizations: sliced.scopeNormalizations }),
        };
    }
}
