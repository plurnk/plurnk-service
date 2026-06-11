import { ParserRuleContext } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPath } from "jsonpath-plus";
import type {
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    FoldStatement,
    KillStatement,
    LineMarker,
    MatcherBody,
    MoveStatement,
    ParsedPath,
    PlurnkOp,
    PlurnkStatement,
    Position,
    ReadStatement,
    SendBody,
    SendStatement,
    OpenStatement,
} from "./types.ts";
import type {
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    FoldStatementContext,
    IntOpModifiersContext,
    KillStatementContext,
    MoveStatementContext,
    ReadStatementContext,
    SendStatementContext,
    OpenStatementContext,
    StatementContext,
    TagOpModifiersContext,
} from "./generated/plurnkParser.ts";
import {
    IdentSignalContext,
    IntSignalContext,
    LineMarkerContext,
    TargetContext,
    TagSignalContext,
} from "./generated/plurnkParser.ts";
import PlurnkParseError from "./PlurnkParseError.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type TagSlots = { signal: string[] | null; target: ParsedPath | null; lineMarker: LineMarker | null };
type IntSlots = { signal: number | null; target: ParsedPath | null };
type ExecSlots = { signal: string | null; target: ParsedPath | null };

export default class AstBuilder {
    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

    // Schemes whose `://X/Y` form actually carries an authority (host/userinfo/port).
    // Everything else is opaque: the first segment after `://` is just the first
    // segment of the path, not a host.
    static #AUTHORITY_SCHEMES = new Set([
        "http", "https",
        "ws", "wss",
        "ftp", "ftps",
        "file",
    ]);

    static build(ctx: StatementContext): PlurnkStatement {
        const find = ctx.findStatement(); if (find) return AstBuilder.#buildFind(find);
        const read = ctx.readStatement(); if (read) return AstBuilder.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return AstBuilder.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return AstBuilder.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return AstBuilder.#buildMove(move);
        const open = ctx.openStatement(); if (open) return AstBuilder.#buildOpen(open);
        const fold = ctx.foldStatement(); if (fold) return AstBuilder.#buildFold(fold);
        const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
        const exec = ctx.execStatement(); if (exec) return AstBuilder.#buildExec(exec);
        const kill = ctx.killStatement(); if (kill) return AstBuilder.#buildKill(kill);
        throw new Error("statement context has no recognized alternative");
    }

    static #buildFind(ctx: FindStatementContext): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "FIND",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_FIND().getText(), "FIND"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildRead(ctx: ReadStatementContext): ReadStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "READ",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_READ().getText(), "READ"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildOpen(ctx: OpenStatementContext): OpenStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "OPEN",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_OPEN().getText(), "OPEN"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildFold(ctx: FoldStatementContext): FoldStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "FOLD",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_FOLD().getText(), "FOLD"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        return {
            op: "EDIT",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_EDIT().getText(), "EDIT"),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildCopy(ctx: CopyStatementContext): CopyStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "COPY",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_COPY().getText(), "COPY"),
            ...slots,
            body: raw !== null ? AstBuilder.parsePath(raw, position) : null,
            position,
        };
    }

    static #buildMove(ctx: MoveStatementContext): MoveStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "MOVE",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_MOVE().getText(), "MOVE"),
            ...slots,
            body: raw !== null ? AstBuilder.parsePath(raw, position) : null,
            position,
        };
    }

    static #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx.intOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_SEND().getText(), "SEND"),
            ...slots,
            lineMarker: null,
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    static #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractExecSlots(ctx.execModifiers(), position);
        return {
            op: "EXEC",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_EXEC().getText(), "EXEC"),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx.intOpModifiers(), position);
        return {
            op: "KILL",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_KILL().getText(), "KILL"),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #extractTagSlots(modCtx: TagOpModifiersContext | null, pos: Position): TagSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #extractIntSlots(modCtx: IntOpModifiersContext | null, pos: Position): IntSlots {
        const intCtx = AstBuilder.#findFirst(modCtx, IntSignalContext);
        const intNode = intCtx?.INT() ?? null;
        return {
            signal: intNode !== null ? Number.parseInt(intNode.getText(), 10) : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
        };
    }

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position): ExecSlots {
        const identCtx = AstBuilder.#findFirst(modCtx, IdentSignalContext);
        const identNode = identCtx?.IDENT() ?? null;
        return {
            signal: identNode !== null ? identNode.getText() : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
        };
    }

    static #findFirst<T extends ParserRuleContext>(
        root: ParserRuleContext | null,
        type: Ctor<T>,
    ): T | null {
        if (root === null) return null;
        if (root instanceof type) return root;
        const children = root.children;
        if (!children) return null;
        for (const child of children) {
            if (child instanceof ParserRuleContext) {
                const found = AstBuilder.#findFirst(child, type);
                if (found !== null) return found;
            }
        }
        return null;
    }

    static #tagsFromSignal(ctx: TagSignalContext | null): string[] | null {
        if (ctx === null) return null;
        const tags = ctx.TAG();
        return Array.isArray(tags) ? tags.map((t) => t.getText()) : [];
    }

    static #targetFromCtx(ctx: TargetContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const text = ctx.TARGET_TEXT()?.getText() ?? "";
        return AstBuilder.parsePath(text, pos);
    }

    static #lineMarkerFromCtx(ctx: LineMarkerContext | null): LineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return AstBuilder.#parseLineMarker(text);
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #bodyTextOf(ctx: { body(): { getText(): string } | null }): string | null {
        const bodyCtx = ctx.body();
        return bodyCtx ? bodyCtx.getText() : null;
    }

    static #splitSuffix(openTagText: string, op: PlurnkOp): string {
        return openTagText.slice(2 + op.length);
    }

    static #isDigit(c: string | undefined): boolean {
        return c !== undefined && c >= "0" && c <= "9";
    }

    static #parseLineMarker(text: string): LineMarker {
        const inner = text.slice(1, -1);
        let i = 0;
        if (inner[i] === "-") i++;
        while (AstBuilder.#isDigit(inner[i])) i++;
        const first = Number.parseInt(inner.slice(0, i), 10);
        if (i >= inner.length) return { first, last: null };
        if (inner[i] === ",") {
            i++;
            if (inner[i] === " ") i++;
        } else {
            i++;
        }
        const last = Number.parseInt(inner.slice(i), 10);
        return { first, last };
    }

    /**
     * Parse a path string into a ParsedPath, mirroring how the AST visitor
     * decomposes path slots inside HEREDOC statements. Public for consumers
     * (RPC layers, scheme handlers) that need to honor the grammar's
     * authority-vs-opaque cleavage without round-tripping through a fake
     * HEREDOC. Returns null when `raw` is empty. Throws PlurnkParseError
     * when `raw` starts with `scheme://` but WHATWG URL rejects it.
     */
    static parsePath(raw: string, pos: Position = { line: 0, column: 0 }): ParsedPath | null {
        if (raw.length === 0) return null;
        if (!AstBuilder.#SCHEME_PATTERN.test(raw)) {
            return { kind: "local", raw };
        }
        let url: URL;
        try {
            url = new URL(raw);
        } catch (e: any) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid URI in path: ${e?.message ?? raw}`);
        }
        const scheme = url.protocol.replace(/:$/, "");
        const params = AstBuilder.#paramsFrom(url.searchParams);
        const fragment = url.hash ? url.hash.slice(1) : null;

        if (AstBuilder.#AUTHORITY_SCHEMES.has(scheme)) {
            return {
                kind: "url",
                raw,
                scheme,
                username: url.username || null,
                password: url.password || null,
                hostname: url.hostname || null,
                port: url.port ? Number.parseInt(url.port, 10) : null,
                pathname: url.pathname,
                params,
                fragment,
            };
        }
        // Opaque scheme: the first segment after `://` is just the first segment
        // of the path, not a host. Take the substring between `scheme://` and
        // the first `?`/`#` boundary as the pathname; authority fields are null.
        const afterScheme = raw.slice(scheme.length + 3);
        const qIdx = afterScheme.indexOf("?");
        const hIdx = afterScheme.indexOf("#");
        let pathnameEnd = afterScheme.length;
        if (qIdx >= 0 && (hIdx < 0 || qIdx < hIdx)) {
            pathnameEnd = qIdx;
        } else if (hIdx >= 0) {
            pathnameEnd = hIdx;
        }
        return {
            kind: "url",
            raw,
            scheme,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: afterScheme.slice(0, pathnameEnd),
            params,
            fragment,
        };
    }

    static #paramsFrom(sp: URLSearchParams): Record<string, string | string[]> {
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of sp) {
            const existing = params[key];
            if (existing === undefined) {
                params[key] = value;
            } else if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                params[key] = [existing, value];
            }
        }
        return params;
    }

    // Matcher dispatch: try the prefix-indicated dialect; if it doesn't parse cleanly,
    // fall through to glob. Same robustness principle for every prefix — dispatch is a
    // hint, not a gate. Lets literal `//`-comments, `/path/`-strings, and `$`-prefixed
    // shell-ish text reach the model as glob matches instead of hard-erroring.
    // Semantic (`~`) and graph (`@`) have no parse step — any text is a valid query
    // — so they dispatch directly.
    static #parseMatcherBody(body: string, pos: Position): MatcherBody {
        if (body.startsWith("//")) {
            try { xpath.parse(body); return { dialect: "xpath", raw: body }; }
            catch { /* fall through to glob */ }
        } else if (body.startsWith("/")) {
            const regex = AstBuilder.#tryParseRegex(body);
            if (regex !== null) return { dialect: "regex", raw: body, ...regex };
        } else if (body.startsWith("$")) {
            try { JSONPath({ path: body, json: {} }); return { dialect: "jsonpath", raw: body }; }
            catch { /* fall through to glob */ }
        } else if (body.startsWith("~")) {
            return { dialect: "semantic", raw: body };
        } else if (body.startsWith("@")) {
            return { dialect: "graph", raw: body };
        }
        return { dialect: "glob", raw: body };
    }

    static #tryParseRegex(body: string): { pattern: string; flags: string } | null {
        let i = 1;
        while (i < body.length) {
            if (body[i] === "\\") { i += 2; continue; }
            if (body[i] === "/") break;
            i++;
        }
        if (i >= body.length) return null;
        const pattern = body.slice(1, i);
        const flags = body.slice(i + 1);
        try { new RegExp(pattern, flags); } catch { return null; }
        return { pattern, flags };
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
