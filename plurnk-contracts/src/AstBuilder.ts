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
    UrlPath,
} from "./types.ts";
import type {
    BuffStatementContext,
    BareStatementContext,
    ClientStatementContext,
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    KillStatementContext,
    WorkStatementContext,
    ForkStatementContext,
    LookStatementContext,
    MoveStatementContext,
    ResourceSelectionContext,
    SlotModifiersContext,
    ReadStatementContext,
    StatementContext,
    MidStatementContext,
} from "./generated/plurnkParser.ts";
import {
    BodyContext,
    LineMarkerContext,
    MetadataContext,
    MidSendContext,
    PlanStatementContext,
    SendStatementContext,
    TargetContext,
    TargetWithMetadataContext,
} from "./generated/plurnkParser.ts";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PathSyntax from "./PathSyntax.ts";
import PlanValue from "./PlanValue.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type SchemeMetadata = string[] | null;
type Slots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: LineMarker | null };
type TextSlots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: TextLineMarker | null };

export default class AstBuilder {
    // {§misplaced-annotation-advisory} — advisories raised while building one statement; the
    // parser drains them right after the statement so the model sees WHAT it did on the first try.
    static #advisories: PlurnkParseError[] = [];

    static takeAdvisories(): PlurnkParseError[] {
        const taken = AstBuilder.#advisories;
        AstBuilder.#advisories = [];
        return taken;
    }

    // A body that is solely an HTML comment can never be a matcher. Preserve it
    // as the operation annotation and report only that deterministic normalization.
    static #annotationBody(op: string, delimiter: string, annotation: string | null, raw: string | null, position: Position): { annotation: string | null; raw: string | null } {
        if (raw === null) return { annotation, raw };
        const comment = /^\s*<!--([\s\S]*?)-->\s*$/u.exec(raw);
        if (comment === null) return { annotation, raw };
        AstBuilder.#advisories.push(new PlurnkParseError(
            position.line,
            position.column,
            "parser",
            `The ${op} body contained only an HTML comment; it was applied as the operation annotation.`,
            "warning",
        ));
        return { annotation: annotation ?? (comment[1] ?? "").trim(), raw: null };
    }

    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
    // Compile-only RFC 9535 admission using the runtime's JSONPath engine. {§matcher-prefix-claims}
    static #JSONPATH = new JSONPathEnvironment();
    static #GRAPH_MATCHER = /^&[<>]?[^\s<>]\S*$/u;

    static build(ctx: StatementContext | MidStatementContext | PlanStatementContext | SendStatementContext | MidSendContext): PlurnkStatement {
        // The strict turn root attaches the leading PLAN and the terminal SEND as direct
        // children (not wrapped in `statement`), so dispatch those by type first.
        if (ctx instanceof PlanStatementContext) return AstBuilder.#buildPlan(ctx);
        if (ctx instanceof SendStatementContext) return AstBuilder.#buildSend(ctx);
        if (ctx instanceof MidSendContext) return AstBuilder.#buildMidSend(ctx);
        const midSend = ctx.midSend(); if (midSend) return AstBuilder.#buildMidSend(midSend);
        const find = ctx.findStatement(); if (find) return AstBuilder.#buildFind(find);
        const read = ctx.readStatement(); if (read) return AstBuilder.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return AstBuilder.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return AstBuilder.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return AstBuilder.#buildMove(move);
        const exec = ctx.execStatement(); if (exec) return AstBuilder.#buildExec(exec);
        const bare = ctx.bareStatement(); if (bare) return AstBuilder.#buildBare(bare);
        const work = ctx.workStatement(); if (work) return AstBuilder.#buildWork(work);
        const fork = ctx.forkStatement(); if (fork) return AstBuilder.#buildFork(fork);
        const kill = ctx.killStatement(); if (kill) return AstBuilder.#buildKill(kill);
        // `midStatement` has no planStatement alternative (PLAN is never a mid-op); only the
        // full `statement` rule does.
        if ("planStatement" in ctx) {
            const plan = ctx.planStatement(); if (plan) return AstBuilder.#buildPlan(plan);
            const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
        }
        throw new Error("statement context has no recognized alternative");
    }

    static #buildFind(ctx: FindStatementContext): FindStatement {
        const positionForBody = AstBuilder.#positionOf(ctx);
        const bodied = AstBuilder.#annotationBody("FIND", AstBuilder.#splitDelimiter(ctx.OPEN_FIND().getText(), "FIND"), AstBuilder.#annotationOf(ctx), AstBuilder.#bodyTextOf(ctx), positionForBody);
        return AstBuilder.#buildFindFrom(ctx, bodied.annotation, bodied.raw);
    }

    static #buildFindFrom(ctx: FindStatementContext, annotation: string | null, raw: string | null): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSlots(ctx.slotModifiers(), position);
        return {
            op: "FIND",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_FIND().getText(), "FIND"),
            annotation,
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
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
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
        const slots = AstBuilder.#extractSlots(ctx.slotModifiers(), position);
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
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const delimiter = AstBuilder.#splitDelimiter(ctx.OPEN_READ().getText(), "READ");
        const bodied = AstBuilder.#annotationBody("READ", delimiter, AstBuilder.#annotationOf(ctx), AstBuilder.#bodyTextOf(ctx), position);
        const annotation = bodied.annotation;
        const raw = bodied.raw;
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
            const findSlots = slots as Slots;
            return {
                op: "FIND",
                delimiter,
                annotation,
                ...findSlots,
                body: hasMatcher ? AstBuilder.#parseMatcherBody(raw, position) : null,
                position,
            };
        }
        return {
            op: "READ",
            delimiter,
            annotation,
            ...slots,
            body: null,
            position,
        };
    }

    static #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
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
        const modifier = ctx.transferModifiers();
        const selections = modifier.resourceSelection();
        if (selections.length !== 2) throw new Error("COPY grammar did not produce two resource selections");
        return {
            op: "COPY",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_COPY().getText(), "COPY"),
            annotation: AstBuilder.#annotationOf(ctx),
            source: AstBuilder.#resourceSelectionFromCtx(selections[0]!, position),
            destination: AstBuilder.#resourceSelectionFromCtx(selections[1]!, position),
            position,
        };
    }

    static #buildMove(ctx: MoveStatementContext): MoveStatement {
        const position = AstBuilder.#positionOf(ctx);
        const modifier = ctx.transferModifiers();
        const selections = modifier.resourceSelection();
        if (selections.length !== 2) throw new Error("MOVE grammar did not produce two resource selections");
        return {
            op: "MOVE",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_MOVE().getText(), "MOVE"),
            annotation: AstBuilder.#annotationOf(ctx),
            source: AstBuilder.#resourceSelectionFromCtx(selections[0]!, position),
            destination: AstBuilder.#resourceSelectionFromCtx(selections[1]!, position),
            position,
        };
    }

    // {§send-label} — a disposition label makes the SEND terminal and names no recipient.
    static readonly #SEND_LABELS: Readonly<Record<string, 102 | 200 | 202 | 499>> = Object.freeze({ NEXT: 102, WAIT: 202, TERM: 200, FAIL: 499 });

    static #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const label = ctx.SEND_LABEL().getText().slice(1, -1);
        const status = AstBuilder.#SEND_LABELS[label];
        if (status === undefined) throw new Error(`the lexer admitted an unknown SEND label: ${label}`);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_SEND().getText(), "SEND"),
            annotation: AstBuilder.#annotationOf(ctx),
            status,
            target: null,
            metadata: null,
            // A WAIT keeps its scope ({§send-wait-scope}); the dispatcher owns what it accepts.
            lineMarker: AstBuilder.#lineMarkerFromCtx(ctx.lineMarker()),
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    // A mid-turn SEND is a message to its recipient path, or to the user when it names none.
    static #buildMidSend(ctx: MidSendContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_SEND().getText(), "SEND"),
            annotation: AstBuilder.#annotationOf(ctx),
            status: null,
            target: slots.target,
            metadata: slots.metadata,
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
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_EXEC().getText(), "EXEC"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildBare(ctx: BareStatementContext): BareStatement {
        const position = AstBuilder.#positionOf(ctx);
        return {
            op: "BARE",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_BARE().getText(), "BARE"),
            annotation: AstBuilder.#annotationOf(ctx),
            target: null,
            metadata: null,
            lineMarker: null,
            body: AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildPlan(ctx: PlanStatementContext): PlanStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSlots(ctx.slotModifiers(), position);
        const rejected = [
            slots.target !== null ? "(path)" : null,
            slots.metadata !== null ? "{metadata}" : null,
            slots.lineMarker !== null ? "<scope>" : null,
        ].filter((slot): slot is string => slot !== null);
        if (rejected.length > 0) {
            throw new PlurnkParseError(
                position.line,
                position.column,
                "visitor",
                `PLAN does not accept ${AstBuilder.#joinTerms(rejected)}.`,
            );
        }
        return {
            op: "PLAN",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_PLAN().getText(), "PLAN"),
            annotation: AstBuilder.#annotationOf(ctx),
            target: null,
            metadata: null,
            lineMarker: null,
            body: PlanValue.admit(AstBuilder.#requiredBodyTextOf(ctx)),
            position,
        };
    }

    static #joinTerms(terms: readonly string[]): string {
        if (terms.length < 2) return terms[0] ?? "";
        if (terms.length === 2) return `${terms[0]} and ${terms[1]}`;
        return `${terms.slice(0, -1).join(", ")}, and ${terms.at(-1)}`;
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        // {§kill-scope} — the scope names lines of a log body or of an entry; null kills the whole target.
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "KILL",
            delimiter: AstBuilder.#splitDelimiter(ctx.OPEN_KILL().getText(), "KILL"),
            annotation: AstBuilder.#annotationOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildWork(ctx: WorkStatementContext): WorkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
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
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
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

    static #extractBranchSlots(ctx: TargetWithMetadataContext | null, pos: Position): { target: ParsedPath | null; metadata: SchemeMetadata } {
        return {
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(ctx),
        };
    }

    static #extractSlots(modCtx: SlotModifiersContext | null, pos: Position): Slots {
        return {
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #extractTextSlots(modCtx: SlotModifiersContext | null, pos: Position): TextSlots {
        return {
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: AstBuilder.#textLineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
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

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position): Slots {
        // {§exec-path-runtime} — every slot at most once; the grammar admits any order.
        const once = <T extends ParserRuleContext>(type: Ctor<T>, slot: string): T | null => {
            const found = AstBuilder.#findAll(modCtx, type);
            if (found.length > 1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `\`## EXEC0\` accepts ${slot} at most once`);
            }
            return found[0] ?? null;
        };
        return {
            target: AstBuilder.#targetFromCtx(once(TargetContext, "one `(runtime/tool)` path"), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: AstBuilder.#lineMarkerFromCtx(once(LineMarkerContext, "one `<scope>`")),
        };
    }
    static #findAll<T extends ParserRuleContext>(root: ParserRuleContext | null, type: Ctor<T>): T[] {
        if (root === null) return [];
        if (root instanceof type) return [root];
        return (root.children ?? []).flatMap((child) => child instanceof ParserRuleContext ? AstBuilder.#findAll(child, type) : []);
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

    static #targetFromCtx(ctx: TargetContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const text = ctx.TARGET_TEXT().map((token) => token.getText()).join("");
        return AstBuilder.parsePath(text, pos);
    }

    static #metadataFromCtx(ctx: ParserRuleContext | null): SchemeMetadata {
        const blocks = AstBuilder.#findAll(ctx, MetadataContext);
        return blocks.length === 0
            ? null
            : blocks.map((block) => block.METADATA_TEXT().map((token) => token.getText()).join(""));
    }

    static #resourceSelectionFromCtx(ctx: ResourceSelectionContext, pos: Position): ResourceSelection {
        const target = AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos);
        if (target === null) throw new Error("resource selection grammar did not produce a target");
        return {
            target,
            metadata: AstBuilder.#metadataFromCtx(ctx),
            lineMarker: AstBuilder.#textLineMarkerFromCtx(AstBuilder.#findFirst(ctx, LineMarkerContext)),
        };
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
        const protectedTarget = AstBuilder.#protectPathBraces(target);
        let url: URL;
        try {
            url = new URL(protectedTarget.value);
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
            pathname: protectedTarget.restore(url.pathname),
            query: AstBuilder.#queryFrom(url),
            fragment: url.hash ? url.hash.slice(1) : null,
        };
        return parsed;
    }

    // WHATWG percent-encodes raw braces. Protect only authored path braces while
    // decomposing so brace globs remain distinguishable from authored `%7B`/`%7D`
    // literal path data. Query and fragment spelling remain untouched.
    static #protectPathBraces(target: string): { value: string; restore: (pathname: string) => string } {
        const authorityStart = target.indexOf("://") + 3;
        const pathStart = target.indexOf("/", authorityStart);
        if (pathStart < 0) return { value: target, restore: (pathname) => pathname };
        const queryStart = target.indexOf("?", pathStart);
        const fragmentStart = target.indexOf("#", pathStart);
        const endings = [queryStart, fragmentStart].filter((index) => index >= 0);
        const pathEnd = endings.length === 0 ? target.length : Math.min(...endings);
        const rawPath = target.slice(pathStart, pathEnd);
        if (!/[{}]/u.test(rawPath)) return { value: target, restore: (pathname) => pathname };

        const sentinels: string[] = [];
        for (let codePoint = 0xF0000; sentinels.length < 2; codePoint += 1) {
            const character = String.fromCodePoint(codePoint);
            const encoded = encodeURIComponent(character);
            if (!target.includes(character) && !target.toUpperCase().includes(encoded)) sentinels.push(encoded);
        }
        const [open, close] = sentinels as [string, string];
        const protectedPath = rawPath.replaceAll("{", open).replaceAll("}", close);
        return {
            value: target.slice(0, pathStart) + protectedPath + target.slice(pathEnd),
            restore: (pathname) => pathname.replaceAll(open, "{").replaceAll(close, "}"),
        };
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
        // At statement EOF ANTLR retains one ordinary terminating line ending in
        // BODY_TEXT; before a following heading the lexer consumes that same EOL as
        // SECTION_END. Normalize the equivalent surfaces before enforcing one line.
        const raw = body.replace(/(?:\r\n|\r|\n)$/u, "");
        const lineCount = raw.split(/\r\n|\r|\n/u).length;
        if (lineCount !== 1) {
            throw new PlurnkParseError(
                pos.line,
                pos.column,
                "visitor",
                `Matcher body has ${lineCount} lines; expected 1.`,
            );
        }
        if (raw.startsWith("//")) {
            try { xpath.parse(raw); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`//\` but is not a valid xpath selector - ${AstBuilder.#detail(e)}`);
            }
            return { dialect: "xpath", raw };
        }
        if (raw.startsWith("/")) {
            const regex = AstBuilder.#tryParseSlashRegex(raw);
            if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
            if (regex.reason === "invalid" && /^[\t ]/u.test(regex.flags)) {
                throw new PlurnkParseError(
                    pos.line,
                    pos.column,
                    "visitor",
                    "Regex matcher has trailing text after its closing `/`; operation modifiers precede the line ending, and the matcher occupies the next line.",
                );
            }
            const slashRecovery = regex.reason === "invalid"
                && regex.detail.includes("Invalid flags supplied")
                ? " - use only ECMAScript flags after the closing `/`; escape a literal `/` inside the pattern as `\\/`"
                : "";
            // Quote the offending matcher so a multi-op emission's failure is
            // unambiguous about WHICH body failed (a correct sibling regex must
            // not take the blame for a broken one).
            const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
            throw new PlurnkParseError(pos.line, pos.column, "visitor",
                regex.reason === "unclosed"
                    ? `regex matcher must use \`/pattern/flags\`; this matcher has no closing \`/\`: \`${excerpt}\``
                    : `pattern leads with \`/\` but is not a valid \`/pattern/flags\` regex - ${regex.detail}${slashRecovery}: \`${excerpt}\``);
        }
        if (raw.startsWith("$")) {
            // Compile-only RFC 9535 admission through the shared json-p3 engine.
            try { AstBuilder.#JSONPATH.compile(raw); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`$\` but is not a valid jsonpath - ${AstBuilder.#detail(e)}`);
            }
            return { dialect: "jsonpath", raw };
        }
        if (raw.startsWith("~")) return { dialect: "semantic", raw };
        if (raw.startsWith("&")) {
            if (!AstBuilder.#GRAPH_MATCHER.test(raw)) {
                throw new PlurnkParseError(
                    pos.line,
                    pos.column,
                    "visitor",
                    "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
                );
            }
            return { dialect: "graph", raw };
        }
        return { dialect: "glob", raw };
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
        | { ok: false; reason: "invalid"; detail: string; flags: string } {
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
        catch (e) { return { ok: false, reason: "invalid", detail: AstBuilder.#detail(e), flags }; }
        return { ok: true, pattern, flags };
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
