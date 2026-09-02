// Shared DSL statement constructors for tests. Every integration test that
// dispatches an op uses one of these.

import type {
    ReadStatement, SendStatement, KillStatement,
    FindStatement, CopyStatement, MoveStatement, ExecStatement,
    LocalPath, UrlPath, ParsedPath, MatcherBody, LineMarker, TextLineMarker, Plan,
} from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";

export const urlPath = (scheme: string, pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}${fragment !== null ? `#${fragment}` : ""}`,
    scheme, username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment,
});

export const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

export const planValue = (content: string): Plan => [
    { content, status: "in_progress" },
];

// {§edit-marker-required-on-existing}: a marker is required on an existing
// entry; states a deliberate whole-content rewrite explicitly, resolving through
// the ordinary marker math to a full replace.
export const fullReplace: LineMarker = { marks: [1, -1] };

export const editStmt = (target: ParsedPath | null, body: string | null = null, marker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

export const readStmt = (target: ParsedPath | null, lineMarker: TextLineMarker | null = null): ReadStatement => ({
    metadata: null,
    op: "READ", annotation: null, delimiter: "", target, lineMarker, body: null,
    position: { line: 1, column: 1 },
});

export const sendStmt = (status: SendStatement["status"], recipient: ParsedPath | null = null, body: string | null = null): SendStatement => ({
    metadata: null,
    op: "SEND", annotation: null, delimiter: "", status, target: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

// {§kill-scope} — a scoped KILL folds one log body interval or deletes an entry span; a
// matcher body selects the rows.
export const killStmt = (target: ParsedPath | null, lineMarker: TextLineMarker | null = null, body: MatcherBody | null = null): KillStatement => ({
    metadata: null,
    op: "KILL", annotation: null, delimiter: "", target, lineMarker, body,
    position: { line: 1, column: 1 },
});

export const findStmt = (target: ParsedPath | null, body: MatcherBody | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", annotation: null, delimiter: "", target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const copyStmt = (
    src: ParsedPath,
    dst: ParsedPath,
    sourceMarker: TextLineMarker | null = null,
    destinationMarker: TextLineMarker | null = null,
): CopyStatement => ({
    op: "COPY", annotation: null, delimiter: "",
    source: { target: src, metadata: null, lineMarker: sourceMarker },
    destination: { target: dst, metadata: null, lineMarker: destinationMarker },
    position: { line: 1, column: 1 },
});

export const moveStmt = (
    src: ParsedPath,
    dst: ParsedPath,
    sourceMarker: TextLineMarker | null = null,
    destinationMarker: TextLineMarker | null = null,
): MoveStatement => ({
    op: "MOVE", annotation: null, delimiter: "",
    source: { target: src, metadata: null, lineMarker: sourceMarker },
    destination: { target: dst, metadata: null, lineMarker: destinationMarker },
    position: { line: 1, column: 1 },
});

// {§exec-path-runtime} — EXEC names its runtime as the first path segment and the
// runtime's target (tool, program, cwd, or resource) after it; a bare EXEC is the shell.
export const execPath = (runtime: string, target: ParsedPath | null = null): ParsedPath | null => {
    if (target === null) return runtime === "sh" ? null : localPath(runtime);
    return localPath(`${runtime}/${target.raw}`);
};

export const execStmt = (runtime: string, body: string | null = null, target: ParsedPath | null = null): ExecStatement => ({
    metadata: null,
    op: "EXEC", annotation: null, delimiter: "", target: execPath(runtime, target), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
export const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });
