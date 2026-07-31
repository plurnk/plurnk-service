// The free default READ an executor-scheme inherits (executor-is-a-scheme RFC —
// schemes#20 / service#240): generic matcher selection and `<L>` projection
// over a produced output blob, reusing Slicer + Matcher so the logic is
// single-sourced (not forked into BaseExecutor). A pure resolver - given the
// stored output + the READ statement, it returns which text to serve; the
// executor-scheme delivers them. READ-purity holds: this reads already-produced
// output, it never triggers EXEC.

import type { ReadStatement } from "@plurnk/plurnk-grammar";
import type { TextRegion } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Slicer from "./Slicer.ts";
import Matcher from "./Matcher.ts";
import type { MatchResult } from "./Matcher.ts";
import type { RangeExtent } from "./Slicer.ts";
import type { SchemeResult } from "./Results.ts";

export interface ReadResolution extends SchemeResult {
    readonly body?: string;
    readonly startLine?: number;
    readonly region?: TextRegion;
    readonly range?: RangeExtent;
}

export default class DefaultRead {
    // Resolve a READ against an output blob:
    //   matcher body present -> select the complete blob and retain coordinates
    //   <L> text scope       -> project text from the selected blob
    //   no <L>               -> return the complete selected blob
    static async read(
        content: string,
        mimetype: string,
        statement: ReadStatement,
        mimetypes: Mimetypes,
    ): Promise<ReadResolution> {
        let matches: MatchResult["matches"];
        let selectionFallback: MatchResult | null = null;
        if (statement.body !== null) {
            const selected = await Matcher.matchAgainstContent(statement.body, content, mimetype, mimetypes);
            if (selected.status === 203) selectionFallback = selected;
            else if (selected.status !== 200) return selected;
            else matches = selected.matches;
        }
        if (statement.lineMarker !== null) {
            const s = Slicer.lines(content, statement.lineMarker);
            if (s.status >= 400) return s;
            return {
                status: selectionFallback?.status ?? (s.text === "" ? 204 : s.status),
                body: s.text,
                ...(s.startLine === undefined ? {} : { startLine: s.startLine }),
                ...(s.region === undefined ? {} : { region: s.region }),
                ...(s.range === undefined ? {} : { range: s.range }),
                ...(matches === undefined ? {} : { matches }),
                ...(selectionFallback?.mimetype === undefined ? {} : { mimetype: selectionFallback.mimetype }),
                ...(selectionFallback?.reason === undefined ? {} : { reason: selectionFallback.reason }),
            };
        }
        if (selectionFallback !== null) return selectionFallback;
        return {
            status: 200,
            body: content,
            ...(matches === undefined ? {} : { matches }),
        };
    }
}
