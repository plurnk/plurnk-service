import type { StatementContext } from "./generated/plurnkParser.ts";
import { PlurnkParseError } from "./errors.ts";
import * as xpath from "xpath";
import { JSONPath } from "jsonpath-plus";

// The xpath package's .d.ts omits its `parse` function (it only types the
// document-evaluation surface). Augment the type here — `parse` is exported
// at runtime and throws on a syntactically invalid XPath 1.0 expression.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

export type Position = { line: number; column: number };

export type PlurnkOp =
    | "FIND"
    | "READ"
    | "EDIT"
    | "COPY"
    | "MOVE"
    | "SHOW"
    | "HIDE"
    | "SEND"
    | "EXEC";

export interface LineMarker {
    /** First position. Can be negative (sentinels: 0 = prepend anchor, -1 = append anchor). */
    first: number;
    /** Second position when the marker is a range `<N-M>`; null when single `<N>`. */
    last: number | null;
}

/**
 * Parsed path slot. A path is either a local source path (no scheme — filesystem-style)
 * or a URL with a recognized `scheme://` prefix. URLs are fully decomposed via WHATWG URL;
 * locals are kept as raw strings (resolution is the runtime's job).
 *
 * Subdomain / registrable-domain splitting requires the public suffix list (PSL) and is
 * deferred to the runtime — `hostname` is the full host string as parsed by URL.
 */
export type ParsedPath = LocalPath | UrlPath;

export interface LocalPath {
    kind: "local";
    raw: string;
}

export interface UrlPath {
    kind: "url";
    raw: string;
    /** Scheme without trailing `:` — `"https"`, `"known"`, etc. */
    scheme: string;
    username: string | null;
    password: string | null;
    /** Full hostname as parsed by URL. For custom schemes (`known://draft`), this is the first authority segment. */
    hostname: string | null;
    port: number | null;
    /** Path component (everything after the authority, before `?` or `#`). May be empty. */
    pathname: string;
    /** Query parameters. Multi-value keys are arrays. Empty record if no query. */
    search: Record<string, string | string[]>;
    /** Fragment (after `#`), with the `#` stripped; null if no fragment. */
    fragment: string | null;
}

interface StatementBase<S> {
    suffix: string;
    signal: S | null;
    path: ParsedPath | null;
    lineMarker: LineMarker | null;
    position: Position;
}

/**
 * Typed body for FIND/READ/SHOW/HIDE pattern matchers. The dialect is detected
 * by the body's leading characters and validated by the Visitor — `xpath` via
 * `xpath.parse()`, `regex` via `new RegExp()`, `jsonpath` via `jsonpath-plus`,
 * `glob` is pass-through.
 */
export type MatcherBody =
    | { dialect: "xpath"; raw: string }
    | { dialect: "regex"; raw: string; pattern: string; flags: string; regexp: RegExp }
    | { dialect: "jsonpath"; raw: string }
    | { dialect: "glob"; raw: string };

/**
 * Typed body for SEND. The raw payload is always present; `json` holds the
 * `JSON.parse(raw)` result if the body is valid JSON, null otherwise.
 * Best-effort: plain-text bodies (`<<SEND[200]:Paris:SEND`) leave json=null.
 */
export interface SendBody {
    raw: string;
    json: unknown | null;
}

/** Matcher OPs: body is a typed pattern matcher (or null if no body). */
export interface FindStatement extends StatementBase<string[]> { op: "FIND"; body: MatcherBody | null; }
export interface ReadStatement extends StatementBase<string[]> { op: "READ"; body: MatcherBody | null; }
export interface ShowStatement extends StatementBase<string[]> { op: "SHOW"; body: MatcherBody | null; }
export interface HideStatement extends StatementBase<string[]> { op: "HIDE"; body: MatcherBody | null; }

/** EDIT body is arbitrary content (markdown, code, JSON, prose) — kept raw. */
export interface EditStatement extends StatementBase<string[]> { op: "EDIT"; body: string | null; }

/** COPY/MOVE body is the destination URI, parsed identically to the path slot. */
export interface CopyStatement extends StatementBase<string[]> { op: "COPY"; body: ParsedPath | null; }
export interface MoveStatement extends StatementBase<string[]> { op: "MOVE"; body: ParsedPath | null; }

/** SEND body: raw plus best-effort JSON parse. */
export interface SendStatement extends StatementBase<number> { op: "SEND"; body: SendBody | null; }

/** EXEC body is a command or code snippet — kept raw. */
export interface ExecStatement extends StatementBase<string> { op: "EXEC"; body: string | null; }

export type PlurnkStatement =
    | FindStatement
    | ReadStatement
    | EditStatement
    | CopyStatement
    | MoveStatement
    | ShowStatement
    | HideStatement
    | SendStatement
    | ExecStatement;

const OPS: readonly PlurnkOp[] = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "SHOW", "HIDE", "SEND", "EXEC",
];

const splitOpAndSuffix = (openTagText: string): { op: PlurnkOp; suffix: string } => {
    const stripped = openTagText.slice(2);
    for (const op of OPS) {
        if (stripped.startsWith(op)) {
            return { op, suffix: stripped.slice(op.length) };
        }
    }
    throw new Error(`unrecognized OP in open tag: ${openTagText}`);
};

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

const parseLineMarker = (text: string): LineMarker => {
    const inner = text.slice(1, -1);
    let i = 0;
    if (inner[i] === "-") i++;
    while (isDigit(inner[i])) i++;
    const first = Number.parseInt(inner.slice(0, i), 10);
    if (i >= inner.length) return { first, last: null };
    i++;
    const last = Number.parseInt(inner.slice(i), 10);
    return { first, last };
};

const coerceSendSignal = (raw: string[] | null, pos: Position): number | null => {
    if (raw === null) return null;
    if (raw.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "SEND signal slot is present but empty");
    }
    if (raw.length > 1) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `SEND signal must be a single integer; got ${raw.length} values`);
    }
    const text = raw[0]!;
    if (!/^-?\d+$/.test(text)) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `SEND signal must be an integer; got "${text}"`);
    }
    return Number.parseInt(text, 10);
};

const coerceExecSignal = (raw: string[] | null, pos: Position): string | null => {
    if (raw === null) return null;
    if (raw.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "EXEC signal slot is present but empty");
    }
    if (raw.length > 1) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `EXEC signal must be a single runtime tag; got ${raw.length} values`);
    }
    return raw[0]!;
};

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

const parsePath = (raw: string, pos: Position): ParsedPath | null => {
    if (raw.length === 0) return null;
    if (!SCHEME_PATTERN.test(raw)) {
        return { kind: "local", raw };
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch (e: any) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid URI in path: ${e?.message ?? raw}`);
    }
    const search: Record<string, string | string[]> = {};
    for (const [key, value] of url.searchParams) {
        const existing = search[key];
        if (existing === undefined) {
            search[key] = value;
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            search[key] = [existing, value];
        }
    }
    return {
        kind: "url",
        raw,
        scheme: url.protocol.replace(/:$/, ""),
        username: url.username || null,
        password: url.password || null,
        hostname: url.hostname || null,
        port: url.port ? Number.parseInt(url.port, 10) : null,
        pathname: url.pathname,
        search,
        fragment: url.hash ? url.hash.slice(1) : null,
    };
};

type MatcherDialect = "xpath" | "regex" | "jsonpath" | "glob";

const detectMatcherDialect = (body: string): MatcherDialect => {
    if (body.startsWith("//")) return "xpath";
    if (body.startsWith("/")) return "regex";
    if (body.startsWith("$")) return "jsonpath";
    return "glob";
};

const parseRegexLiteral = (body: string, pos: Position): { pattern: string; flags: string } => {
    let i = 1;
    while (i < body.length) {
        if (body[i] === "\\") { i += 2; continue; }
        if (body[i] === "/") break;
        i++;
    }
    if (i >= body.length) {
        throw new PlurnkParseError(pos.line, pos.column, "visitor", "regex body missing closing /");
    }
    return { pattern: body.slice(1, i), flags: body.slice(i + 1) };
};

const parseMatcherBody = (body: string, pos: Position): MatcherBody => {
    const dialect = detectMatcherDialect(body);
    if (dialect === "regex") {
        const { pattern, flags } = parseRegexLiteral(body, pos);
        let regexp: RegExp;
        try {
            regexp = new RegExp(pattern, flags);
        } catch (e: any) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid regex: ${e?.message ?? body}`);
        }
        return { dialect: "regex", raw: body, pattern, flags, regexp };
    }
    if (dialect === "xpath") {
        try {
            xpath.parse(body);
        } catch (e: any) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid xpath: ${e?.message ?? body}`);
        }
        return { dialect: "xpath", raw: body };
    }
    if (dialect === "jsonpath") {
        try {
            JSONPath({ path: body, json: {} });
        } catch (e: any) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid jsonpath: ${e?.message ?? body}`);
        }
        return { dialect: "jsonpath", raw: body };
    }
    return { dialect: "glob", raw: body };
};

const parseSendBody = (raw: string): SendBody => {
    let json: unknown | null = null;
    try { json = JSON.parse(raw); } catch { /* best-effort: not all SEND bodies are JSON */ }
    return { raw, json };
};

export const buildStatement = (ctx: StatementContext): PlurnkStatement => {
    const openTagCtx = ctx.openTag();
    const openTagText = openTagCtx.getText();
    const { op, suffix } = splitOpAndSuffix(openTagText);

    const start = ctx.start ?? openTagCtx.start;
    const position: Position = {
        line: start?.line ?? 0,
        column: start?.column ?? 0,
    };

    const signalCtx = ctx.signal();
    let rawSignal: string[] | null = null;
    if (signalCtx) {
        const text = signalCtx.SIGNAL_TEXT()?.getText() ?? "";
        rawSignal = text.length > 0 ? text.split(",") : [];
    }

    const pathCtx = ctx.path();
    let rawPath: string | null = null;
    if (pathCtx) {
        rawPath = pathCtx.PATH_TEXT()?.getText() ?? "";
    }
    const path: ParsedPath | null = rawPath !== null ? parsePath(rawPath, position) : null;

    const lineMarkerCtx = ctx.lineMarker();
    let lineMarker: LineMarker | null = null;
    if (lineMarkerCtx) {
        const text = lineMarkerCtx.L_MARKER()?.getText() ?? "";
        lineMarker = parseLineMarker(text);
    }

    const bodyCtx = ctx.body();
    const rawBody: string | null = bodyCtx ? bodyCtx.getText() : null;

    // Per-OP signal coercion.
    let signal: string[] | number | string | null;
    switch (op) {
        case "SEND":
            signal = coerceSendSignal(rawSignal, position);
            break;
        case "EXEC":
            signal = coerceExecSignal(rawSignal, position);
            break;
        default:
            signal = rawSignal;
    }

    // Per-OP body shaping.
    let body: MatcherBody | ParsedPath | SendBody | string | null;
    switch (op) {
        case "FIND":
        case "READ":
        case "SHOW":
        case "HIDE":
            body = rawBody !== null ? parseMatcherBody(rawBody, position) : null;
            break;
        case "COPY":
        case "MOVE":
            body = rawBody !== null ? parsePath(rawBody, position) : null;
            break;
        case "SEND":
            body = rawBody !== null ? parseSendBody(rawBody) : null;
            break;
        case "EDIT":
        case "EXEC":
            body = rawBody;
            break;
    }

    return { op, suffix, signal, path, lineMarker, body, position } as PlurnkStatement;
};
