/// <reference path="./json-p3-esm.d.ts" />

import { ParserRuleContext, TerminalNode } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPathEnvironment } from "json-p3/dist/json-p3.esm.js";
import type {
    BuffStatement,
    BareStatement,
    ClientOp,
    ClientStatement,
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    FoldStatement,
    KillStatement,
    WorkStatement,
    ForkStatement,
    LineMarker,
    LookStatement,
    MatcherBody,
    MoveStatement,
    ResourceSelection,
    ParsedPath,
    PlanStatement,
    PlurnkOp,
    PlurnkStatement,
    Position,
    ReadStatement,
    SendBody,
    SendStatement,
    TextLineMarker,
    OpenStatement,
    UrlPath,
} from "./types.ts";
import { COMBINED_ANCHOR_LINE_DIAGNOSTIC } from "./PlurnkErrorStrategy.ts";
import type {
    BuffStatementContext,
    BareStatementContext,
    ClientStatementContext,
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    FoldStatementContext,
    KillStatementContext,
    WorkStatementContext,
    ForkStatementContext,
    BranchModifiersContext,
    CurationModifiersContext,
    LookStatementContext,
    MoveStatementContext,
    ReadStatementContext,
    OpenStatementContext,
    StatementContext,
    MidStatementContext,
    MidSendContext,
    TagOpModifiersContext,
} from "./generated/plurnkParser.ts";
import {
    BodyContext,
    IdentSignalContext,
    LineMarkerContext,
    PlanStatementContext,
    SendStatementContext,
    TargetContext,
    TagSignalContext,
    BranchSignalContext,
} from "./generated/plurnkParser.ts";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PathSyntax from "./PathSyntax.ts";
import TagSignal, { InvalidTagSignalError } from "./TagSignal.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type TagSlots = { signal: string[] | null; target: ParsedPath | null; lineMarker: LineMarker | null };
type TextTagSlots = { signal: string[] | null; target: ParsedPath | null; lineMarker: TextLineMarker | null };
type CurationSlots = { signal: string[] | null; target: ParsedPath | null; lineMarker: null };
type IntSlots = { signal: number | null; target: ParsedPath | null };
type ExecSlots = { signal: string | null; target: ParsedPath | null; lineMarker: LineMarker | null };

export default class AstBuilder {
    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
    static #RESOURCE_SELECTION_TAIL = /(<-?\d+(?:\.\d+)?(?:(?:-|, ?)-?\d+(?:\.\d+)?)*>)(:*)$/;
    static #ANCHORED_RESOURCE_SELECTION_TAIL = new RegExp(
        String.raw`(<(?:-?\d+(?:\.\d+)?|@[0-9A-Za-z]{5})(?:, ?(?:-?\d+(?:\.\d+)?|@[0-9A-Za-z]{5}))*>)` + String.raw`(:*)$`,
    );
    static #COMBINED_RESOURCE_SELECTION_TAIL = new RegExp(
        String.raw`(<(?:-?\d+(?:\.\d+)?|@[0-9A-Za-z]{5}|@[0-9A-Za-z]{5}(?::| )[1-9]\d*)`
        + String.raw`(?:, ?(?:-?\d+(?:\.\d+)?|@[0-9A-Za-z]{5}|@[0-9A-Za-z]{5}(?::| )[1-9]\d*))*>)$`,
    );
    static #COMBINED_LINE_COORD = /@[0-9A-Za-z]{5}(?::| )[1-9]\d*/;
    // Compile-only RFC 9535 admission using the runtime's JSONPath engine. {§matcher-prefix-claims}
    static #JSONPATH = new JSONPathEnvironment();

    static build(ctx: StatementContext | MidStatementContext | PlanStatementContext | SendStatementContext): PlurnkStatement {
        // The strict turn root attaches the leading PLAN and the terminal SEND as direct
        // children (not wrapped in `statement`), so dispatch those by type first.
        if (ctx instanceof PlanStatementContext) return AstBuilder.#buildPlan(ctx);
        if (ctx instanceof SendStatementContext) return AstBuilder.#buildSend(ctx);
        const find = ctx.findStatement(); if (find) return AstBuilder.#buildFind(find);
        const read = ctx.readStatement(); if (read) return AstBuilder.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return AstBuilder.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return AstBuilder.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return AstBuilder.#buildMove(move);
        const open = ctx.openStatement(); if (open) return AstBuilder.#buildOpen(open);
        const fold = ctx.foldStatement(); if (fold) return AstBuilder.#buildFold(fold);
        const midSend = ctx.midSend(); if (midSend) return AstBuilder.#buildSend(midSend);
        // `sendStatement` (the disposition-coded terminal) appears in `statement` (teaching
        // corpora) but NOT in `midStatement` — guard the accessor before calling it.
        if ("sendStatement" in ctx) {
            const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
        }
        const exec = ctx.execStatement(); if (exec) return AstBuilder.#buildExec(exec);
        const bare = ctx.bareStatement(); if (bare) return AstBuilder.#buildBare(bare);
        const work = ctx.workStatement(); if (work) return AstBuilder.#buildWork(work);
        const fork = ctx.forkStatement(); if (fork) return AstBuilder.#buildFork(fork);
        const kill = ctx.killStatement(); if (kill) return AstBuilder.#buildKill(kill);
        // `midStatement` has no planStatement alternative (PLAN is never a mid-op); only the
        // full `statement` rule does.
        if ("planStatement" in ctx) {
            const plan = ctx.planStatement(); if (plan) return AstBuilder.#buildPlan(plan);
        }
        throw new Error("statement context has no recognized alternative");
    }

    static #buildFind(ctx: FindStatementContext): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        AstBuilder.#assertAppliedTags(slots.signal, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "FIND",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_FIND().getText(), "FIND"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    // Client-tier dispatch (parseClient). A `clientStatement` is either a protocol `statement`
    // (delegated to build, returning a PlurnkStatement — which IS a ClientStatement) or one of
    // the two client-only ops. Kept separate from build() so the protocol return type stays the
    // closed PlurnkStatement and client ops never leak into it.
    static buildClient(ctx: ClientStatementContext): ClientStatement {
        const statement = ctx.statement(); if (statement) return AstBuilder.build(statement);
        const look = ctx.lookStatement(); if (look) return AstBuilder.#buildLook(look);
        const buff = ctx.buffStatement(); if (buff) return AstBuilder.#buildBuff(buff);
        throw new Error("clientStatement context has no recognized alternative");
    }

    // LOOK / BUFF are client-tier matcher observations. They share the tag slots
    // and parse matcher bodies directly for their client-owned lifecycles.
    static #buildLook(ctx: LookStatementContext): LookStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "LOOK",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_LOOK().getText(), "LOOK"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildBuff(ctx: BuffStatementContext): BuffStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "BUFF",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_BUFF().getText(), "BUFF"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildRead(ctx: ReadStatementContext): FindStatement | ReadStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextTagSlots(ctx.tagOpModifiers(), position);
        AstBuilder.#assertAppliedTags(slots.signal, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        const targetPath = slots.target?.kind === "url"
            ? slots.target.pathname
            : slots.target?.raw;
        const hasMatcher = raw !== null && raw.trim() !== "";
        if (hasMatcher || (targetPath !== undefined && PathSyntax.hasGlob(targetPath))) {
            if (slots.lineMarker?.marks.some((mark) => typeof mark === "string") === true) {
                throw new PlurnkParseError(
                    position.line,
                    position.column,
                    "visitor",
                    "line anchors require an exact READ target; FIND result positions are numeric",
                );
            }
            const findSlots = slots as TagSlots;
            return {
                op: "FIND",
                delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_READ().getText(), "READ"),
                annotation: AstBuilder.#annotationOf(ctx),
                ...findSlots,
                body: hasMatcher ? AstBuilder.#parseMatcherBody(raw, position) : null,
                position,
            };
        }
        return {
            op: "READ",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_READ().getText(), "READ"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: null,
            position,
        };
    }

    static #buildOpen(ctx: OpenStatementContext): OpenStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractCurationSlots(ctx.curationModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        const tags = AstBuilder.#curationTags(slots.signal, position);
        if (slots.target === null && raw === null && tags.filter.length === 0 && (tags.add.length > 0 || tags.remove.length > 0)) {
            throw new PlurnkParseError(
                position.line,
                position.column,
                "visitor",
                "signed tags modify selected log items but do not select them - add a path, body pattern, or unsigned tag",
            );
        }
        return {
            op: "OPEN",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_OPEN().getText(), "OPEN"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildFold(ctx: FoldStatementContext): FoldStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractCurationSlots(ctx.curationModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        const tags = AstBuilder.#curationTags(slots.signal, position);
        if (slots.target === null && raw === null && tags.filter.length === 0 && (tags.add.length > 0 || tags.remove.length > 0)) {
            throw new PlurnkParseError(
                position.line,
                position.column,
                "visitor",
                "signed tags modify selected log items but do not select them - add a path, body pattern, or unsigned tag",
            );
        }
        return {
            op: "FOLD",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_FOLD().getText(), "FOLD"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextTagSlots(ctx.tagOpModifiers(), position);
        AstBuilder.#assertAppliedTags(slots.signal, position);
        return {
            op: "EDIT",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_EDIT().getText(), "EDIT"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildCopy(ctx: CopyStatementContext): CopyStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextTagSlots(ctx.tagOpModifiers(), position);
        AstBuilder.#assertAppliedTags(slots.signal, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "COPY",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_COPY().getText(), "COPY"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw === null ? null : AstBuilder.parseResourceSelection(raw, position),
            position,
        };
    }

    static #buildMove(ctx: MoveStatementContext): MoveStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextTagSlots(ctx.tagOpModifiers(), position);
        AstBuilder.#assertAppliedTags(slots.signal, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "MOVE",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_MOVE().getText(), "MOVE"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.parseResourceSelection(raw, position) : null,
            position,
        };
    }

    static #buildSend(ctx: SendStatementContext | MidSendContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_SEND().getText(), "SEND"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            // Preserve a terminal wait scope; the dispatcher owns which disposition
            // accepts it. Only the terminal rule carries a marker (midSend → null).
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(ctx, LineMarkerContext)),
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    static #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractExecSlots(ctx.execModifiers(), position);
        return {
            op: "EXEC",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_EXEC().getText(), "EXEC"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildBare(ctx: BareStatementContext): BareStatement {
        const position = AstBuilder.#positionOf(ctx);
        const signal = AstBuilder.#tagsFromSignal(ctx.tagSignal());
        AstBuilder.#assertAppliedTags(signal, position);
        return {
            op: "BARE",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_BARE().getText(), "BARE"),
            annotation: AstBuilder.#annotationOf(ctx),
            signal,
            target: null,
            lineMarker: null,
            body: AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildPlan(ctx: PlanStatementContext): PlanStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        return {
            op: "PLAN",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_PLAN().getText(), "PLAN"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx, position);
        return {
            op: "KILL",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_KILL().getText(), "KILL"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildWork(ctx: WorkStatementContext): WorkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.branchModifiers(), position);
        return {
            op: "WORK",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_WORK().getText(), "WORK"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildFork(ctx: ForkStatementContext): ForkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.branchModifiers(), position);
        return {
            op: "FORK",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_FORK().getText(), "FORK"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #extractBranchSlots(ctx: BranchModifiersContext | null, pos: Position): {
        signal: string | null;
        target: ParsedPath | null;
    } {
        const signal = AstBuilder.#findFirst(ctx, BranchSignalContext)?.TAG()?.getText() ?? null;
        return {
            signal,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos),
        };
    }

    static #extractTagSlots(modCtx: TagOpModifiersContext | null, pos: Position): TagSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #extractTextTagSlots(modCtx: TagOpModifiersContext | null, pos: Position): TextTagSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#textLineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #extractCurationSlots(modCtx: CurationModifiersContext | null, pos: Position): CurationSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: null,
        };
    }

    // A SEND/KILL signal is one signed-integer literal, tokenized as INT (mid-comms SEND, KILL)
    // or DISPOSITION (the terminal SEND — the parser tokenizes {102,200,202,300,499} distinctly
    // so a disposition-coded SEND is structurally terminal). `ctx` is the whole SEND/KILL
    // statement; the only INT/DISPOSITION token is the signal, the only target the recipient.
    static #extractIntSlots(ctx: ParserRuleContext | null, pos: Position): IntSlots {
        const sig = AstBuilder.#findToken(ctx, plurnkLexer.INT) ?? AstBuilder.#findToken(ctx, plurnkLexer.DISPOSITION);
        return {
            signal: sig !== null ? Number.parseInt(sig, 10) : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos),
        };
    }

    // Depth-first search for the first terminal of `tokenType`; returns its text or null.
    // Lets the SEND/KILL signal read work regardless of which signal rule wrapped it.
    static #findToken(root: ParserRuleContext | null, tokenType: number): string | null {
        if (root === null) return null;
        for (const child of root.children ?? []) {
            if (child instanceof TerminalNode && child.symbol.type === tokenType) return child.getText();
            if (child instanceof ParserRuleContext) {
                const found = AstBuilder.#findToken(child, tokenType);
                if (found !== null) return found;
            }
        }
        return null;
    }

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position): ExecSlots {
        const identCtx = AstBuilder.#findFirst(modCtx, IdentSignalContext);
        const identNode = identCtx?.IDENT() ?? null;
        return {
            signal: identNode !== null ? identNode.getText() : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
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

    static #assertAppliedTags(signal: readonly string[] | null, position: Position): void {
        try {
            TagSignal.applied(signal);
        } catch (cause) {
            if (!(cause instanceof InvalidTagSignalError)) throw cause;
            throw new PlurnkParseError(position.line, position.column, "visitor", cause.message);
        }
    }

    static #curationTags(signal: readonly string[] | null, position: Position): ReturnType<typeof TagSignal.curation> {
        try {
            return TagSignal.curation(signal);
        } catch (cause) {
            if (!(cause instanceof InvalidTagSignalError)) throw cause;
            throw new PlurnkParseError(position.line, position.column, "visitor", cause.message);
        }
    }

    static #targetFromCtx(ctx: TargetContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const text = ctx.TARGET_TEXT().map((token) => token.getText()).join("");
        return AstBuilder.parsePath(text, pos);
    }

    static #lineMarkerFromCtx(ctx: LineMarkerContext | null): LineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return AstBuilder.#parseLineMarker(text);
    }

    static #textLineMarkerFromCtx(ctx: LineMarkerContext | null): TextLineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return AstBuilder.#parseTextLineMarker(text);
    }

    static #parseTextLineMarker(text: string): TextLineMarker {
        if (!text.includes("@")) return AstBuilder.#parseLineMarker(text);
        const marks = text.slice(1, -1).split(/, ?/).map((component) =>
            component.startsWith("@") ? component : Number.parseFloat(component));
        return { marks: marks as [number | string, ...(number | string)[]] };
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #annotationOf(ctx: ParserRuleContext): string | null {
        const token = AstBuilder.#findToken(ctx, plurnkLexer.ANNOTATION);
        return token === null ? null : token.slice("<!--".length, -"-->".length).trim();
    }

    static #bodyTextOf(ctx: ParserRuleContext): string | null {
        return AstBuilder.#findFirst(ctx, BodyContext)?.getText() ?? null;
    }

    static #requiredBodyTextOf(ctx: ParserRuleContext): string {
        return AstBuilder.#bodyTextOf(ctx) ?? "";
    }

    static #splitDelimiter(headingText: string, op: PlurnkOp | ClientOp): string {
        const marker = op === "PLAN" ? "# " : "## ";
        return headingText.slice(marker.length + op.length);
    }

    static #isDigit(c: string | undefined): boolean {
        return c !== undefined && c >= "0" && c <= "9";
    }

    // Scans `<scope>` into ordered numeric components. Separators are `,`
    // (with an optional space) or `-`; a `-` immediately starting a component is its
    // sign, not a separator. The operation owner assigns roles. {§scope-marker-forms}
    static #parseLineMarker(text: string): LineMarker {
        const inner = text.slice(1, -1);
        const marks: number[] = [];
        let i = 0;
        while (i < inner.length) {
            let j = i;
            if (inner[j] === "-") j++;
            while (AstBuilder.#isDigit(inner[j])) j++;
            if (inner[j] === "." && AstBuilder.#isDigit(inner[j + 1])) {
                j++;
                while (AstBuilder.#isDigit(inner[j])) j++;
            }
            marks.push(Number.parseFloat(inner.slice(i, j)));
            i = j;
            if (inner[i] === ",") {
                i++;
                if (inner[i] === " ") i++;
            } else if (inner[i] === "-") {
                i++;
            } else {
                break;
            }
        }
        // L_MARKER always matches at least one number, so marks is non-empty.
        return { marks: marks as [number, ...number[]] };
    }

    /**
     * Parse a COPY/MOVE body into its destination target and optional trailing
     * scope. The scope is adjacent to the destination it selects:
     * `destination.txt<12,5,12,5>`.
     */
    static parseResourceSelection(
        raw: string,
        pos: Position = { line: 0, column: 0 },
    ): ResourceSelection | null {
        if (raw.length === 0) return null;
        const combinedMarker = AstBuilder.#COMBINED_RESOURCE_SELECTION_TAIL.exec(raw)?.[1];
        if (combinedMarker !== undefined && AstBuilder.#COMBINED_LINE_COORD.test(combinedMarker)) {
            throw new PlurnkParseError(
                pos.line,
                pos.column,
                "visitor",
                COMBINED_ANCHOR_LINE_DIAGNOSTIC,
            );
        }
        const markerMatch = AstBuilder.#ANCHORED_RESOURCE_SELECTION_TAIL.exec(raw)
            ?? AstBuilder.#RESOURCE_SELECTION_TAIL.exec(raw);
        const markerText = markerMatch?.[1] ?? null;
        if ((markerMatch?.[2].length ?? 0) > 0) {
            throw new PlurnkParseError(
                pos.line,
                pos.column,
                "visitor",
                "COPY/MOVE destination scope must end the destination selection; remove the extra `:` after the scope",
            );
        }
        const pathText = markerText === null ? raw : raw.slice(0, -markerText.length);
        const target = AstBuilder.parsePath(pathText, pos);
        if (target === null) return null;
        return {
            target,
            lineMarker: markerText === null ? null : AstBuilder.#parseTextLineMarker(markerText),
        };
    }

    /**
     * Apply target-slot decomposition without round-tripping through a statement.
     * Returns null for empty input and throws PlurnkParseError when a scheme URL
     * fails WHATWG admission. {§path-syntax}
     */
    static parsePath(raw: string, pos: Position = { line: 0, column: 0 }): ParsedPath | null {
        if (raw.length === 0) return null;
        const target = PathSyntax.unescapeTarget(raw);
        if (!AstBuilder.#SCHEME_PATTERN.test(target)) {
            return { kind: "local", raw: target };
        }
        // Split trailing request metadata before WHATWG decomposition; the addressed
        // scheme interprets the preserved ordered pairs. {§path-request-metadata}
        const braceIdx = target.indexOf("{");
        const urlPart = braceIdx === -1 ? target : target.slice(0, braceIdx);
        const headers = braceIdx === -1 ? null : AstBuilder.#splitHeaders(target.slice(braceIdx), pos);
        let url: URL;
        try {
            url = new URL(urlPart);
        } catch {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid URI in path");
        }
        // Uniform WHATWG decomposition — no per-scheme authority allowlist. `://`
        // introduces an authority for every scheme; an authority-less reference
        // writes the empty-authority form `scheme:///path` (host parses empty).
        // Whether a given scheme should carry an authority is a runtime concern,
        // not the grammar's; the parser just reports what the standard parsed.
        const parsed: UrlPath = {
            kind: "url",
            raw: target,
            scheme: url.protocol.replace(/:$/, ""),
            username: url.username || null,
            password: url.password || null,
            hostname: url.hostname || null,
            port: url.port ? Number.parseInt(url.port, 10) : null,
            pathname: url.pathname,
            query: AstBuilder.#queryFrom(url),
            fragment: url.hash ? url.hash.slice(1) : null,
        };
        if (headers) parsed.headers = headers;
        return parsed;
    }

    // Split a target's trailing `{key: value}` request-metadata region into ordered pairs.
    // Each block is one header (the value ends at `}`, so commas inside a value are
    // fine); the key is the text before the first `:`, the value the trimmed rest
    // (internal colons kept). Fail-hard on a malformed region (stray text, unclosed
    // `{`, or a keyless block) — a header slot the scheme can't read is a contract
    // violation, not something to swallow.
    static #splitHeaders(meta: string, pos: Position): [string, string][] {
        const headers: [string, string][] = [];
        let i = 0;
        while (i < meta.length) {
            if (meta[i] !== "{") {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid request metadata: expected a `{name: value}` block");
            }
            const end = meta.indexOf("}", i + 1);
            if (end === -1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid request metadata: unclosed `{name: value}` block");
            }
            const inner = meta.slice(i + 1, end);
            const colon = inner.indexOf(":");
            if (colon === -1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid request metadata: missing `:` separator");
            }
            const key = inner.slice(0, colon).trim();
            if (key.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid request metadata: empty name");
            }
            headers.push([key, inner.slice(colon + 1).trim()]);
            i = end + 1;
        }
        return headers;
    }

    static #queryFrom(url: URL): string | null {
        const queryStart = url.href.indexOf("?");
        if (queryStart === -1) return null;
        const fragmentStart = url.href.indexOf("#", queryStart);
        return url.href.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
    }

    // The leading prefix claims its dialect; failed claimed syntax never falls back
    // to glob. XPath's `//` is classified before regex `/`. {§matcher-prefix-claims}
    static #parseMatcherBody(body: string, pos: Position): MatcherBody {
        if (body.startsWith("//")) {
            try { xpath.parse(body); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`//\` but is not a valid xpath selector - ${AstBuilder.#detail(e)}`);
            }
            return { dialect: "xpath", raw: body };
        }
        if (body.startsWith("/")) {
            const regex = AstBuilder.#tryParseSlashRegex(body);
            if (regex.ok) return { dialect: "regex", raw: body, pattern: regex.pattern, flags: regex.flags };
            const slashRecovery = regex.reason === "invalid"
                && regex.detail.includes("Invalid flags supplied")
                ? " - use only ECMAScript flags after the closing `/`; escape a literal `/` inside the pattern as `\\/`"
                : "";
            // Quote the offending matcher so a multi-op emission's failure is
            // unambiguous about WHICH body failed (a correct sibling regex must
            // not take the blame for a broken one).
            const excerpt = body.length > 80 ? `${body.slice(0, 80)}…` : body;
            throw new PlurnkParseError(pos.line, pos.column, "visitor",
                regex.reason === "unclosed"
                    ? `regex matcher must use \`/pattern/flags\`; this matcher has no closing \`/\`: \`${excerpt}\``
                    : `pattern leads with \`/\` but is not a valid \`/pattern/flags\` regex - ${regex.detail}${slashRecovery}: \`${excerpt}\``);
        }
        if (body.startsWith("$")) {
            // Compile-only RFC 9535 admission through the shared json-p3 engine.
            try { AstBuilder.#JSONPATH.compile(body); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`$\` but is not a valid jsonpath - ${AstBuilder.#detail(e)}`);
            }
            return { dialect: "jsonpath", raw: body };
        }
        if (body.startsWith("~")) return { dialect: "semantic", raw: body };
        if (body.startsWith("@")) return { dialect: "graph", raw: body };
        return { dialect: "glob", raw: body };
    }

    static #detail(e: unknown): string {
        return e instanceof Error ? e.message : String(e);
    }

    // Splits an ECMAScript `/pattern/flags` literal. Backslash escapes and character
    // classes keep a slash inside the pattern; the first unescaped slash outside a
    // class closes it. The native constructor owns pattern and flag validity.
    static #tryParseSlashRegex(raw: string):
        { ok: true; pattern: string; flags: string }
        | { ok: false; reason: "unclosed" }
        | { ok: false; reason: "invalid"; detail: string } {
        let i = 1;
        let inClass = false;
        while (i < raw.length) {
            if (raw[i] === "\\") { i += 2; continue; }
            if (raw[i] === "[") {
                inClass = true;
                i++;
                continue;
            }
            if (raw[i] === "]" && inClass) {
                inClass = false;
                i++;
                continue;
            }
            if (raw[i] === "/" && !inClass) break;
            i++;
        }
        if (i >= raw.length) return { ok: false, reason: "unclosed" };
        const pattern = raw.slice(1, i);
        const flags = raw.slice(i + 1);
        try { new RegExp(pattern, flags); }
        catch (e) { return { ok: false, reason: "invalid", detail: AstBuilder.#detail(e) }; }
        return { ok: true, pattern, flags };
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
