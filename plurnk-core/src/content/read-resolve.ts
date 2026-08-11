// Shared exact-target READ projection for entry-bearing schemes, File, and Log.
// READ owns text coordinates only; FIND owns every aggregate or matcher selection.

import { DEFAULT_RETRIEVAL_LIMIT, type LineMarker, type RangeExtent, type TextRegion } from "@plurnk/plurnk-contracts";
import type { SchemeResultBase, ScopeNormalization } from "@plurnk/plurnk-schemes";
import LineMarkerOps from "./line-marker.ts";
import MimetypeBinary from "./mimetype-binary.ts";

export interface ReadSliceResult extends SchemeResultBase {
    content: string | null;
    mimetype: string;
    startLine?: number | null;
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
    }): Promise<ReadSliceResult> {
        const { content, mimetype, lineMarker } = opts;
        const marker = lineMarker ?? { marks: [1, DEFAULT_RETRIEVAL_LIMIT] };
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
        const selectedContent = lineMarker === null
            && sliced.range !== undefined
            && LineMarkerOps.coversAvailable(sliced.range)
            ? content
            : sliced.text ?? "";
        return {
            status: selectedContent === "" ? 204 : 200,
            content: selectedContent,
            mimetype: selectedMimetype,
            startLine: selectedContent === "" ? null : sliced.startLine ?? null,
            ...(sliced.region === undefined ? {} : { region: sliced.region }),
            ...(sliced.range === undefined ? {} : { range: sliced.range }),
            ...(sliced.scopeNormalizations === undefined
                ? {}
                : { scopeNormalizations: sliced.scopeNormalizations }),
        };
    }
}
