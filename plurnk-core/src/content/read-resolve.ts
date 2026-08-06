// Shared READ selection-to-projection resolution for entry-bearing schemes,
// plus `Log` and `File`.
// A body matcher selects the resource against its full readable content; `<L>`
// then projects text from that selected resource. Without `<L>`, READ returns
// the complete selected resource. Match coordinates remain metadata in both
// cases. `<scope>` always addresses the readable textual representation;
// structured matchers may locate content, but do not change scope coordinates.
// Callers bind their own (content, mimetype) and wrap the result.

import type { LineMarker, MatcherBody } from "@plurnk/plurnk-contracts";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { MatchEvidence, RangeExtent, SchemeResultBase, ScopeNormalization } from "@plurnk/plurnk-schemes";
import LineMarkerOps from "./line-marker.ts";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

export interface ReadSliceResult extends SchemeResultBase {
    content: string | null;
    mimetype: string;
    startLine?: number | null;
    region?: TextRegion;
    matches?: ReadonlyArray<MatchEvidence>;
    reason?: string;
    range?: RangeExtent;
    scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
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
        let selectedMatches: ReadonlyArray<MatchEvidence> | undefined;
        let selectionFallback: { mimetype: string; reason?: string } | null = null;

        // Match the complete resource once. The body is a resource predicate;
        // its locations explain the selection but never replace READ content.
        if (body !== null) {
            if (mimetypes === undefined) {
                return {
                    status: 501,
                    content: null,
                    mimetype,
                    reason: "Content matching is unavailable because no mimetypes capability is installed.",
                };
            }
            const matched = await Matcher.matchAgainstContent(body, content, mimetype, mimetypes);
            if (matched.status === 204) return { status: 204, content: "", mimetype, startLine: null, matches: [] };
            if (matched.status === 203) {
                selectionFallback = {
                    mimetype: matched.mimetype ?? "text/markdown",
                    ...(matched.reason === undefined ? {} : { reason: matched.reason }),
                };
            } else if (matched.status !== 200) {
                if (matched.problem === undefined) {
                    throw new Error(`ReadResolve: matcher returned status ${matched.status} without Problem Details`);
                }
                return {
                    status: matched.status,
                    problem: matched.problem,
                    content: null,
                    mimetype,
                    reason: matched.problem.detail,
                };
            } else {
                selectedMatches = matched.matches ?? [];
            }
        }

        let workingContent = content;
        let workingStart: number | null = 1;
        let workingRegion: TextRegion | undefined;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        if (lineMarker !== null) {
            const sliced = LineMarkerOps.sliceLines(content, lineMarker);
            if (sliced.status === 416) return {
                status: 416,
                problem: sliced.problem,
                content: null,
                mimetype,
                reason: sliced.problem?.detail,
                range: sliced.range,
            };
            if (sliced.status !== 200) {
                throw new Error(`ReadResolve: text slicing returned unexpected status ${sliced.status}`);
            }
            workingContent = sliced.text ?? "";
            workingStart = sliced.startLine ?? null;
            workingRegion = sliced.region;
            scopeNormalizations = sliced.scopeNormalizations;
        }

        if (selectionFallback !== null) {
            return {
                status: 203,
                content: workingContent,
                mimetype: selectionFallback.mimetype,
                startLine: workingStart,
                ...(workingRegion === undefined ? {} : { region: workingRegion }),
                ...(selectionFallback.reason === undefined ? {} : { reason: selectionFallback.reason }),
                ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
            };
        }

        if (lineMarker !== null) {
            if (workingContent === "") {
                return {
                    status: 204,
                    content: "",
                    mimetype: MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE,
                    startLine: null,
                    ...(workingRegion === undefined ? {} : { region: workingRegion }),
                    ...(selectedMatches === undefined ? {} : { matches: selectedMatches }),
                    ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
                };
            }
            return {
                status: 200,
                content: workingContent,
                mimetype: MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE,
                startLine: workingStart,
                ...(workingRegion === undefined ? {} : { region: workingRegion }),
                ...(selectedMatches === undefined ? {} : { matches: selectedMatches }),
                ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
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
