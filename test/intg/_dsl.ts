// Shared DSL statement constructors for tests. Every integration test that
// dispatches an op uses one of these.

import type {
    EditStatement, ReadStatement, SendStatement, ShowStatement, HideStatement,
    FindStatement, CopyStatement, MoveStatement, ExecStatement,
    UrlPath, ParsedPath, MatcherBody,
} from "@plurnk/plurnk-grammar";

export const urlPath = (scheme: string, pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}${fragment !== null ? `#${fragment}` : ""}`,
    scheme, username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment,
});

export const editStmt = (target: ParsedPath | null, body: string | null = null, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const readStmt = (target: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const sendStmt = (status: number | null, recipient: ParsedPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

export const showStmt = (target: ParsedPath | null): ShowStatement => ({
    op: "SHOW", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const hideStmt = (target: ParsedPath | null): HideStatement => ({
    op: "HIDE", suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const findStmt = (target: ParsedPath | null, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const copyStmt = (src: ParsedPath, dst: ParsedPath, tags: string[] | null = null): CopyStatement => ({
    op: "COPY", suffix: "", signal: tags, target: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

export const moveStmt = (src: ParsedPath, dst: ParsedPath | null, tags: string[] | null = null): MoveStatement => ({
    op: "MOVE", suffix: "", signal: tags, target: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

// EXEC carries its runtime in `signal` (Exec.ts: signal=runtime, target=cwd,
// body=command); cwd is an optional local/file ParsedPath.
export const execStmt = (runtime: string, body: string | null = null, cwd: ParsedPath | null = null): ExecStatement => ({
    op: "EXEC", suffix: "", signal: runtime, target: cwd, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
export const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });
