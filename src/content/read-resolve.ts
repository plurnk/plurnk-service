// Shared READ slice→match resolution for entry-bearing schemes (Known/Skill/
// Unknown/Exec/Plurnk via `_entry-ops`), plus `Log` and `File`. `<L>` scopes,
// the body matches within the scope: slice-then-match (plurnk.md slot order
// `<L>?:body?`). `<L>` dispatches on source mimetype — JSON → item index
// (sliceJsonItems), line-navigable → line index (sliceLines). Callers bind their
// own (content, mimetype) and wrap the result (e.g. `_entry-ops` adds `channel`).

import type { LineMarker, MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import LineMarkerOps from "./line-marker.ts";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

export interface ReadSliceResult {
    status: number;
    content: string | null;
    mimetype: string;
    startLine?: number | null;
    matches?: number;
    reason?: string;
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
        let workingContent = content;
        let workingStart: number | null = 1;
        let workingMimetypeForSlice = MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
        if (lineMarker !== null) {
            if (MimetypeBinary.isJsonMimetype(mimetype)) {
                const sliced = LineMarkerOps.sliceJsonItems(content, lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.body ?? "[]";
                workingStart = null;
                workingMimetypeForSlice = "application/json";
            } else {
                const sliced = LineMarkerOps.sliceLines(content, lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.text ?? "";
                workingStart = sliced.startLine ?? null;
            }
        }

        if (body !== null) {
            if (mimetypes === undefined) return { status: 500, content: null, mimetype };
            const matched = await Matcher.matchAgainstContent(body, workingContent, mimetype, mimetypes, workingStart ?? 1);
            if (matched.status === 204) return { status: 204, content: "", mimetype: "text/markdown", startLine: null, matches: 0 };
            if (matched.status === 203) {
                // Dialect-parse-failure fallback: raw source as text/markdown; reason surfaces why.
                return { status: 203, content: matched.body ?? "", mimetype: matched.mimetype ?? "text/markdown", startLine: 1, reason: matched.reason };
            }
            if (matched.status !== 200) return { status: matched.status, content: null, mimetype };
            return { status: 200, content: matched.body ?? "", mimetype: "text/markdown", startLine: null, matches: matched.matches };
        }

        if (lineMarker !== null) {
            // `<L>` slice mimetype follows the source family: line-navigable → text/markdown,
            // JSON → application/json (structure preserved for compose, §slice-semantics-compose-pattern). Empty / `[]` → 204.
            const isEmptyJsonArray = workingMimetypeForSlice === "application/json" && workingContent === "[]";
            if (workingContent === "" || isEmptyJsonArray) return { status: 204, content: "", mimetype: workingMimetypeForSlice, startLine: null };
            return { status: 200, content: workingContent, mimetype: workingMimetypeForSlice, startLine: workingStart };
        }

        if (content === "") return { status: 204, content: "", mimetype, startLine: null };
        return { status: 200, content, mimetype, startLine: 1 };
    }
}
