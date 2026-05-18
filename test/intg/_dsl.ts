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

export const editStmt = (path: ParsedPath | null, body: string | null = null, tags: string[] | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const readStmt = (path: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const sendStmt = (status: number | null, recipient: ParsedPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", suffix: "", signal: status, path: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

export const showStmt = (path: ParsedPath | null): ShowStatement => ({
    op: "SHOW", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const hideStmt = (path: ParsedPath | null): HideStatement => ({
    op: "HIDE", suffix: "", signal: null, path, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const findStmt = (path: ParsedPath | null, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", suffix: "", signal, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const copyStmt = (src: ParsedPath, dst: ParsedPath, tags: string[] | null = null): CopyStatement => ({
    op: "COPY", suffix: "", signal: tags, path: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

export const moveStmt = (src: ParsedPath, dst: ParsedPath | null, tags: string[] | null = null): MoveStatement => ({
    op: "MOVE", suffix: "", signal: tags, path: src, lineMarker: null, body: dst,
    position: { line: 1, column: 1 },
});

export const execStmt = (path: ParsedPath | null, body: string | null = null): ExecStatement => ({
    op: "EXEC", suffix: "", signal: null, path, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
export const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });
