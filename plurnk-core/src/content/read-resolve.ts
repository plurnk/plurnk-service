// Shared READ selection-to-projection resolution for entry-bearing schemes
// (Known/Skill/Unknown/Exec/Plurnk via `_entry-ops`), plus `Log` and `File`.
// A body matcher selects the resource against its full readable content; `<L>`
// then projects rows from that selected resource. Without `<L>`, READ returns
// the complete selected resource. Match coordinates remain metadata in both
// cases. `<L>` dispatches on source mimetype - JSON -> item index
// (sliceJsonItems), line-navigable -> line index (sliceLines). Callers
// bind their own (content, mimetype) and wrap the result (e.g. `_entry-ops` adds
// `channel`).

import type { LineMarker, MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { MatchRange, RangeExtent, SchemeResultBase } from "@plurnk/plurnk-schemes";
import LineMarkerOps from "./line-marker.ts";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

export interface ReadSliceResult extends SchemeResultBase {
    content: string | null;
    mimetype: string;
    startLine?: number | null;
    matches?: ReadonlyArray<MatchRange>;
    reason?: string;
    range?: RangeExtent;
}

export default class ReadResolve {
    static async resolve(opts: {
        content: string;
        mimetype: string;
        lineMarker: LineMarker | null;
        body: MatcherBody | null;
        mimetypes: Mimetypes | undefined;
    }): Promise<ReadSliceResult> {
        const { content, mimetype, lineMarker, body, mimetypes } = opts;
        let selectedMatches: ReadonlyArray<MatchRange> | undefined;
        let selectionFallback: { mimetype: string; reason?: string } | null = null;

        // Match the complete resource once. The body is a resource predicate;
        // its locations explain the selection but never replace READ content.
        if (body !== null) {
            if (mimetypes === undefined) return { status: 500, content: null, mimetype };
            const matched = await Matcher.matchAgainstContent(body, content, mimetype, mimetypes);
            if (matched.status === 204) return { status: 204, content: "", mimetype, startLine: null, matches: [] };
            if (matched.status === 203) {
                selectionFallback = {
                    mimetype: matched.mimetype ?? "text/markdown",
                    ...(matched.reason === undefined ? {} : { reason: matched.reason }),
                };
            } else if (matched.status !== 200) {
                return { status: matched.status, content: null, mimetype };
            } else {
                selectedMatches = matched.matches ?? [];
            }
        }

        let workingContent = content;
        let workingStart: number | null = 1;
        let workingMimetypeForSlice = MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
        if (lineMarker !== null) {
            if (selectionFallback === null && MimetypeBinary.isJsonMimetype(mimetype)) {
                const sliced = LineMarkerOps.sliceJsonItems(content, lineMarker);
                if (sliced.status === 416) return {
                    status: 416,
                    problem: sliced.problem,
                    content: null,
                    mimetype,
                    reason: sliced.problem?.detail,
                    range: sliced.range,
                };
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.body ?? "[]";
                workingStart = null;
                workingMimetypeForSlice = "application/json";
            } else {
                const sliced = LineMarkerOps.sliceLines(content, lineMarker);
                if (sliced.status === 416) return {
                    status: 416,
                    problem: sliced.problem,
                    content: null,
                    mimetype,
                    reason: sliced.problem?.detail,
                    range: sliced.range,
                };
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.text ?? "";
                workingStart = sliced.startLine ?? null;
            }
        }

        if (selectionFallback !== null) {
            return {
                status: 203,
                content: workingContent,
                mimetype: selectionFallback.mimetype,
                startLine: workingStart,
                reason: selectionFallback.reason,
            };
        }

        if (lineMarker !== null) {
            // `<L>` slice mimetype follows the source family: line-navigable ->
            // text/markdown, JSON -> application/json. Empty / `[]` -> 204.
            const isEmptyJsonArray = workingMimetypeForSlice === "application/json" && workingContent === "[]";
            if (workingContent === "" || isEmptyJsonArray) return { status: 204, content: "", mimetype: workingMimetypeForSlice, startLine: null };
            return {
                status: 200,
                content: workingContent,
                mimetype: workingMimetypeForSlice,
                startLine: workingStart,
                ...(selectedMatches === undefined ? {} : { matches: selectedMatches }),
            };
        }

        if (content === "") return { status: 204, content: "", mimetype, startLine: null };
        return {
            status: 200,
            content,
            mimetype,
            startLine: 1,
            ...(selectedMatches === undefined ? {} : { matches: selectedMatches }),
        };
    }
}
