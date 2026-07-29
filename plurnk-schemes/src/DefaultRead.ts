// The free default READ an executor-scheme inherits (executor-is-a-scheme RFC —
// schemes#20 / service#240): generic `<L>` slicing and matcher-dialect resolve
// over a produced output blob, reusing Slicer + Matcher so the slicing logic is
// single-sourced (not forked into BaseExecutor). A pure resolver — given the
// stored output + the READ statement, it returns WHICH slice to serve; the
// executor-scheme delivers it. READ-purity holds: this reads already-produced
// output, it never triggers EXEC.

import type { ReadStatement } from "@plurnk/plurnk-grammar";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Slicer from "./Slicer.ts";
import Matcher from "./Matcher.ts";
import type { RangeExtent } from "./Slicer.ts";
import type { SchemeResult } from "./Results.ts";

export interface ReadResolution extends SchemeResult {
    readonly body?: string;
    readonly range?: RangeExtent;
}

export default class DefaultRead {
    // Resolve a READ against an output blob:
    //   matcher body present  → Matcher dispatch (glob/regex/jsonpath/xpath via Mimetypes.query)
    //   else <L> line marker  → Slicer slice
    //   else                  → the whole blob
    static async read(
        content: string,
        mimetype: string,
        statement: ReadStatement,
        mimetypes: Mimetypes,
    ): Promise<ReadResolution> {
        if (statement.body !== null) {
            const m = await Matcher.matchAgainstContent(statement.body, content, mimetype, mimetypes);
            return m;
        }
        if (statement.lineMarker !== null) {
            const s = Slicer.lines(content, statement.lineMarker);
            if (s.status >= 400) return s;
            return { status: s.status, body: s.text, range: s.range };
        }
        return { status: 200, body: content };
    }
}
