import { ParserRuleContext } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPath } from "jsonpath-plus";
import type {
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    HideStatement,
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
    ShowStatement,
} from "./types.ts";
import type {
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    HideStatementContext,
    MoveStatementContext,
    ReadStatementContext,
    SendModifiersContext,
    SendStatementContext,
    ShowStatementContext,
    StatementContext,
    TagOpModifiersContext,
} from "./generated/plurnkParser.ts";
import {
    IdentSignalContext,
    IntSignalContext,
    LineMarkerContext,
    PathContext,
    TagSignalContext,
} from "./generated/plurnkParser.ts";
import PlurnkParseError from "./PlurnkParseError.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type TagSlots = { signal: string[] | null; path: ParsedPath | null; lineMarker: LineMarker | null };
type SendSlots = { signal: number | null; path: ParsedPath | null };
type ExecSlots = { signal: string | null; path: ParsedPath | null };

export default class AstBuilder {
    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

    static build(ctx: StatementContext): PlurnkStatement {
        const find = ctx.findStatement(); if (find) return AstBuilder.#buildFind(find);
        const read = ctx.readStatement(); if (read) return AstBuilder.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return AstBuilder.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return AstBuilder.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return AstBuilder.#buildMove(move);
        const show = ctx.showStatement(); if (show) return AstBuilder.#buildShow(show);
        const hide = ctx.hideStatement(); if (hide) return AstBuilder.#buildHide(hide);
        const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
        const exec = ctx.execStatement(); if (exec) return AstBuilder.#buildExec(exec);
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

    static #buildShow(ctx: ShowStatementContext): ShowStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SHOW",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_SHOW().getText(), "SHOW"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildHide(ctx: HideStatementContext): HideStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "HIDE",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_HIDE().getText(), "HIDE"),
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
            body: raw !== null ? AstBuilder.#parsePath(raw, position) : null,
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
            body: raw !== null ? AstBuilder.#parsePath(raw, position) : null,
            position,
        };
    }

    static #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSendSlots(ctx.sendModifiers(), position);
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

    static #extractTagSlots(modCtx: TagOpModifiersContext | null, pos: Position): TagSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            path: AstBuilder.#pathFromCtx(AstBuilder.#findFirst(modCtx, PathContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #extractSendSlots(modCtx: SendModifiersContext | null, pos: Position): SendSlots {
        const intCtx = AstBuilder.#findFirst(modCtx, IntSignalContext);
        const intNode = intCtx?.INT() ?? null;
        return {
            signal: intNode !== null ? Number.parseInt(intNode.getText(), 10) : null,
            path: AstBuilder.#pathFromCtx(AstBuilder.#findFirst(modCtx, PathContext), pos),
        };
    }

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position): ExecSlots {
        const identCtx = AstBuilder.#findFirst(modCtx, IdentSignalContext);
        const identNode = identCtx?.IDENT() ?? null;
        return {
            signal: identNode !== null ? identNode.getText() : null,
            path: AstBuilder.#pathFromCtx(AstBuilder.#findFirst(modCtx, PathContext), pos),
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

    static #pathFromCtx(ctx: PathContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const text = ctx.PATH_TEXT()?.getText() ?? "";
        return AstBuilder.#parsePath(text, pos);
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
        i++;
        const last = Number.parseInt(inner.slice(i), 10);
        return { first, last };
    }

    static #parsePath(raw: string, pos: Position): ParsedPath | null {
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
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of url.searchParams) {
            const existing = params[key];
            if (existing === undefined) {
                params[key] = value;
            } else if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                params[key] = [existing, value];
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
            params,
            fragment: url.hash ? url.hash.slice(1) : null,
        };
    }

    static #detectMatcherDialect(body: string): "xpath" | "regex" | "jsonpath" | "glob" {
        if (body.startsWith("//")) return "xpath";
        if (body.startsWith("/")) return "regex";
        if (body.startsWith("$")) return "jsonpath";
        return "glob";
    }

    static #parseRegexLiteral(body: string, pos: Position): { pattern: string; flags: string } {
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
    }

    static #parseMatcherBody(body: string, pos: Position): MatcherBody {
        const dialect = AstBuilder.#detectMatcherDialect(body);
        if (dialect === "regex") {
            const { pattern, flags } = AstBuilder.#parseRegexLiteral(body, pos);
            try {
                new RegExp(pattern, flags);
            } catch (e: any) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid regex: ${e?.message ?? body}`);
            }
            return { dialect: "regex", raw: body, pattern, flags };
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
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
