// DSL helpers — clean-shape params → HEREDOC → PlurnkStatement.
//
// Per the "Speak in DSL, not plumbing" Standing Rule: every op.* RPC method
// constructs a HEREDOC string from clean-shape params and parses it via the
// canonical grammar. This guarantees the resulting PlurnkStatement is
// IDENTICAL in shape to what the model would emit, including all
// scheme-specific path parsing rules (grammar 0.3.0+).
//
// The path-parser helper would let us bypass HEREDOC construction; tracked
// in plurnk-grammar issue #7.

import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { LineMarker, PlurnkStatement } from "@plurnk/plurnk-grammar";

// Random suffix per call. Collision space is 2^32 against the user's body
// content; vanishingly unlikely for any reasonable input.
const randomSuffix = (): string => Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0");

const formatTags = (tags: string[] | undefined): string => {
    if (tags === undefined || tags.length === 0) return "";
    return `[${tags.join(",")}]`;
};

const formatLineMarker = (lm: LineMarker | undefined): string => {
    if (lm === undefined || lm === null) return "";
    if (lm.last === null || lm.last === lm.first) return `<${lm.first}>`;
    return `<${lm.first}-${lm.last}>`;
};

const formatPath = (path: string | undefined): string => {
    if (path === undefined) return "";
    return `(${path})`;
};

// Build a HEREDOC statement string. `signal` is the raw signal payload —
// CSV tags `[a,b,c]` for most ops, a single number for SEND (`[200]`),
// a single runtime tag for EXEC (`[node]`).
const buildHeredoc = ({
    op, suffix, signal, path, lineMarker, body,
}: {
    op: string;
    suffix: string;
    signal: string;
    path: string;
    lineMarker: string;
    body: string;
}): string => `<<${op}${suffix}${signal}${path}${lineMarker}:${body}:${op}${suffix}`;

export const parseSingleStatement = (text: string): PlurnkStatement => {
    const result = PlurnkParser.parse(text);
    for (const item of result.items) {
        if (item.kind === "statement") return item.statement;
    }
    throw new Error(`expected a parsed statement, got none from: ${text}`);
};

export const parseAllStatements = (text: string): PlurnkStatement[] => {
    const result = PlurnkParser.parse(text);
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
};

// === Per-op clean-shape → PlurnkStatement ===

interface OpWithMatcher {
    path: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpEditParams {
    path: string;
    content?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpCopyMoveParams {
    source: string;
    destination?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpSendParams {
    status: number;
    recipient?: string;
    body?: string;
}

interface OpExecParams {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export const buildEdit = (p: OpEditParams): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "EDIT", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.path),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.content ?? "",
}));

export const buildRead = (p: OpWithMatcher): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "READ", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.path),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.matcher ?? "",
}));

export const buildFind = (p: { scope: string; matcher?: string; tags?: string[]; lineRange?: LineMarker }): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "FIND", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.scope),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.matcher ?? "",
}));

export const buildShow = (p: OpWithMatcher): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "SHOW", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.path),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.matcher ?? "",
}));

export const buildHide = (p: OpWithMatcher): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "HIDE", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.path),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.matcher ?? "",
}));

export const buildCopy = (p: OpCopyMoveParams): PlurnkStatement => {
    if (p.destination === undefined) throw new Error("op.copy requires destination");
    return parseSingleStatement(buildHeredoc({
        op: "COPY", suffix: randomSuffix(),
        signal: formatTags(p.tags),
        path: formatPath(p.source),
        lineMarker: formatLineMarker(p.lineRange),
        body: p.destination,
    }));
};

export const buildMove = (p: OpCopyMoveParams): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "MOVE", suffix: randomSuffix(),
    signal: formatTags(p.tags),
    path: formatPath(p.source),
    lineMarker: formatLineMarker(p.lineRange),
    body: p.destination ?? "",
}));

export const buildSend = (p: OpSendParams): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "SEND", suffix: randomSuffix(),
    signal: `[${p.status}]`,
    path: p.recipient !== undefined ? formatPath(p.recipient) : "",
    lineMarker: "",
    body: p.body ?? "",
}));

export const buildExec = (p: OpExecParams): PlurnkStatement => parseSingleStatement(buildHeredoc({
    op: "EXEC", suffix: randomSuffix(),
    signal: p.runtime !== undefined ? `[${p.runtime}]` : "",
    path: p.cwd !== undefined ? formatPath(p.cwd) : "",
    lineMarker: "",
    body: p.command ?? "",
}));
