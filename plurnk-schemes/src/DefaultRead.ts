// {§executor-scheme-output} The free default READ an executor-scheme inherits:
// generic matcher selection and `<L>` projection
// over a produced output blob, reusing Slicer + Matcher so the logic is
// single-sourced (not forked into BaseExecutor). A pure resolver - given the
// stored output + the READ statement, it returns which text to serve; the
// executor-scheme delivers them. READ-purity holds: this reads already-produced
// output, it never triggers EXEC.

import { DEFAULT_RETRIEVAL_LIMIT, type RangeExtent, type ReadStatement, type TextRegion } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Slicer from "./Slicer.ts";
import type { SchemeResult } from "./Results.ts";

export interface ReadResolution extends SchemeResult {
    readonly body?: string;
    readonly startLine?: number;
    readonly region?: TextRegion;
    readonly range?: RangeExtent;
}

export default class DefaultRead {
    // Resolve an exact READ against an output blob:
    //   <L> text scope -> project text from the blob
    //   no <L>         -> return lines 1–16
    static async read(
        content: string,
        mimetype: string,
        statement: ReadStatement,
        mimetypes: Mimetypes,
    ): Promise<ReadResolution> {
        const marker = statement.lineMarker ?? { marks: [1, DEFAULT_RETRIEVAL_LIMIT] };
        const s = Slicer.lines(content, marker);
        if (s.status >= 400) return s;
        const body = statement.lineMarker === null
            && s.range !== undefined
            && Slicer.coversAvailable(s.range)
            ? content
            : s.text;
        return {
            status: body === "" ? 204 : s.status,
            body,
            ...(s.startLine === undefined ? {} : { startLine: s.startLine }),
            ...(s.region === undefined ? {} : { region: s.region }),
            ...(s.range === undefined ? {} : { range: s.range }),
        };
    }
}
