// Shared DSL statement constructors for tests. Every integration test that
// dispatches an op uses one of these.

import type {
    ReadStatement, SendStatement, OpenStatement, FoldStatement,
    FindStatement, CopyStatement, MoveStatement, ExecStatement,
    LocalPath, UrlPath, ParsedPath, MatcherBody, LineMarker, TextLineMarker,
} from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";

export const urlPath = (scheme: string, pathname: string, fragment: string | null = null): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}${fragment !== null ? `#${fragment}` : ""}`,
    scheme, username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment,
});

export const localPath = (raw: string): LocalPath => ({ kind: "local", raw });

// {§edit-marker-required-on-existing}: a marker is required on an existing
// entry; states a deliberate whole-content rewrite explicitly, resolving through
// the ordinary marker math to a full replace.
export const fullReplace: LineMarker = { marks: [1, -1] };

export const editStmt = (target: ParsedPath | null, body: string | null = null, tags: string[] | null = null, marker: LineMarker | null = null): ResolvedEditStatement => ({
    op: "EDIT", annotation: null, suffix: "", signal: tags, target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});

export const readStmt = (target: ParsedPath | null, lineMarker: TextLineMarker | null = null): ReadStatement => ({
    op: "READ", annotation: null, suffix: "", signal: null, target, lineMarker, body: null,
    position: { line: 1, column: 1 },
});

export const sendStmt = (status: number | null, recipient: ParsedPath | null = null, body: string | null = null): SendStatement => ({
    op: "SEND", annotation: null, suffix: "", signal: status, target: recipient, lineMarker: null,
    body: body === null ? null : { raw: body, json: null },
    position: { line: 1, column: 1 },
});

export const openStmt = (target: ParsedPath | null): OpenStatement => ({
    op: "OPEN", annotation: null, suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const foldStmt = (target: ParsedPath | null): FoldStatement => ({
    op: "FOLD", annotation: null, suffix: "", signal: null, target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

export const findStmt = (target: ParsedPath | null, body: MatcherBody | null = null, signal: string[] | null = null): FindStatement => ({
    op: "FIND", annotation: null, suffix: "", signal, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const copyStmt = (
    src: ParsedPath,
    dst: ParsedPath,
    tags: string[] | null = null,
    sourceMarker: TextLineMarker | null = null,
    destinationMarker: TextLineMarker | null = null,
): CopyStatement => ({
    op: "COPY", annotation: null, suffix: "", signal: tags, target: src, lineMarker: sourceMarker,
    body: { target: dst, lineMarker: destinationMarker },
    position: { line: 1, column: 1 },
});

export const moveStmt = (
    src: ParsedPath,
    dst: ParsedPath | null,
    tags: string[] | null = null,
    sourceMarker: TextLineMarker | null = null,
    destinationMarker: TextLineMarker | null = null,
): MoveStatement => ({
    op: "MOVE", annotation: null, suffix: "", signal: tags, target: src, lineMarker: sourceMarker,
    body: dst === null ? null : { target: dst, lineMarker: destinationMarker },
    position: { line: 1, column: 1 },
});

// EXEC carries its runtime in `signal`; target is an optional source, program,
// or cwd, and body is the command.
export const execStmt = (runtime: string, body: string | null = null, target: ParsedPath | null = null): ExecStatement => ({
    op: "EXEC", annotation: null, suffix: "", signal: runtime, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

export const glob = (raw: string): MatcherBody => ({ dialect: "glob", raw });
export const regex = (raw: string): MatcherBody => ({ dialect: "regex", raw: `/${raw}/`, pattern: raw, flags: "" });
