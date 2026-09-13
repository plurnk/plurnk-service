/// <reference path="./json-p3-esm.d.ts" />

import { ParserRuleContext, TerminalNode } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPathEnvironment } from "json-p3/dist/json-p3.esm.js";
import type {
    BareStatement,
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
    PlurnkStatement,
    Position,
    ReadStatement,
    SendBody,
    SendStatement,
    DispositionStatement,
    TextLineMarker,
    UrlPath,
} from "./types.ts";
import type {
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
    DispositionStatementContext,
    SendStatementContext,
    TargetContext,
    TargetWithMetadataContext,
} from "./generated/plurnkParser.ts";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PathSyntax from "./PathSyntax.ts";
import PlanValue from "./PlanValue.ts";
import TurnDisposition from "./TurnDisposition.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type SchemeMetadata = string[] | null;
type Slots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: LineMarker | null };
type TextSlots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: TextLineMarker | null };

export default class AstBuilder {
    // {§misplaced-aside-advisory} — advisories raised while building one statement; the
    // parser drains them right after the statement so the model sees WHAT it did on the first try.
    static #advisories: PlurnkParseError[] = [];

    static takeAdvisories(): PlurnkParseError[] {
        const taken = AstBuilder.#advisories;
        AstBuilder.#advisories = [];
        return taken;
    }

    // A body that is solely an HTML comment can never be a matcher. Preserve it
    // as the operation aside and report only that deterministic normalization.
    static #asideBody(op: string, aside: string | null, raw: string | null, position: Position): { aside: string | null; raw: string | null } {
        if (raw === null) return { aside, raw };
        const comment = /^\s*<!--([\s\S]*?)-->\s*$/u.exec(raw);
        if (comment === null) return { aside, raw };
        AstBuilder.#advisories.push(new PlurnkParseError(
            position.line,
            position.column,
            "parser",
            `The ${op} body contained only an HTML comment; it was applied as the operation aside.`,
            "warning",
        ));
        return { aside: aside ?? (comment[1] ?? "").trim(), raw: null };
    }

    // {§matcher-option} — `pattern` is the language's key inside `[metadata]`: lifted into the
    // statement's `matcher`, classified exactly as a body matcher was ({§matcher-prefix-claims}).
    // A block that carries only `pattern` leaves no metadata for the owner; beside other keys the
    // block stays for the owner, whose reader skips the reserved key. The block's shape stays the
    // owner's business ({§scheme-metadata-modifier}): a second block or malformed JSON lifts
    // nothing and reaches the owner's 400 untouched; only a present `pattern` that is not a
    // string, or a malformed matcher, is the language's own positioned diagnostic.
    // {§naked-pattern} — one line of matcher text, its trailing aside split back out. A sigil
    // (`/`, `//`, `$`, `~`, `&`, `^`) is a matcher wherever it stands; a sigil-less glob or literal
    // is one only on the heading line of FIND, READ or KILL, where the text can mean nothing else.
    // {§trailing-slots} — the slots after the matcher peel off the right end of the heading text,
    // aside, scope and option block in any order, until what remains is the matcher.
    static #bareMatcher(raw: string | null, op: string, inline: boolean, position?: Position, carried: { scope: boolean; metadata: boolean } = { scope: false, metadata: false }): { text: string; aside: string | null; scope: string | null; metadata: string | null } | null {
        if (raw === null) return null;
        let text = raw.trim();
        if (text === "" || text.includes("\n")) return null;
        let aside: string | null = null;
        let scope: string | null = null;
        let metadata: string | null = null;
        // A slot the heading already carries is not peeled: a second one is trailing text.
        let scopeFree = !carried.scope;
        let metadataFree = !carried.metadata;
        const scopeTail = op === "FIND" ? AstBuilder.#TAIL_POSITIONS : AstBuilder.#TAIL_TEXT_SCOPE;
        for (;;) {
            const trailingAside = /\s*<!--([\s\S]*?)-->\s*$/u.exec(text);
            if (trailingAside !== null && aside === null) {
                aside = (trailingAside[1] ?? "").trim();
                text = text.slice(0, trailingAside.index).trim();
                continue;
            }
            const trailingScope = scopeTail.exec(text);
            if (trailingScope !== null && scopeFree && trailingScope.index > 0) {
                scope = trailingScope[1]!;
                scopeFree = false;
                text = text.slice(0, trailingScope.index).trim();
                AstBuilder.#adviseTrailing(position, `\`${scope}\` after the pattern was read as the scope; the scope goes before the pattern.`);
                continue;
            }
            const trailingBlock = /\s*\[(\{[\s\S]*\})\]\s*$/u.exec(text);
            if (trailingBlock !== null && metadataFree && trailingBlock.index > 0 && AstBuilder.#isJsonArrayOfObjects(trailingBlock[1]!)) {
                metadata = trailingBlock[1]!;
                metadataFree = false;
                text = text.slice(0, trailingBlock.index).trim();
                AstBuilder.#adviseTrailing(position, `\`[${metadata}]\` after the pattern was read as the option block; options go before the pattern.`);
                continue;
            }
            break;
        }
        if (text === "") return null;
        if (AstBuilder.#SIGIL.test(text)) return { text, aside, scope, metadata };
        if (!inline || (op !== "FIND" && op !== "READ" && op !== "KILL")) return null;
        return { text, aside, scope, metadata };
    }

    static #adviseTrailing(position: Position | undefined, message: string): void {
        if (position === undefined) return;
        AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser", message, "warning"));
    }

    static #isJsonArrayOfObjects(inner: string): boolean {
        try {
            const parsed = JSON.parse(`[${inner}]`) as unknown;
            return Array.isArray(parsed) && parsed.every((element) => typeof element === "object" && element !== null && !Array.isArray(element));
        } catch { return false; }
    }

    static readonly #SIGIL = /^(\/|\$|~|&|\^)/u;
    // The scope shapes the lexer admits, matched at the right end of the heading text.
    static readonly #TAIL_POSITIONS = /\s*(<-?[0-9]+(?:\.[0-9]+)?(?:(?:,\s?|-)-?[0-9]+(?:\.[0-9]+)?)*>)\s*$/u;
    static readonly #TAIL_TEXT_SCOPE = /\s*(<(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}(?:[: ][1-9][0-9]*)?|@[0-9]{1,4})(?:(?:,\s?|-)(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}(?:[: ][1-9][0-9]*)?|@[0-9]{1,4}))*>)\s*$/u;

    // The body text that opened on the heading line itself, split from the lines beneath it.
    static #splitInlineBody(ctx: ParserRuleContext, position: Position): { inline: string | null; below: string | null } {
        const text = AstBuilder.#bodyTextOf(ctx);
        if (text === null) return { inline: null, below: null };
        const body = AstBuilder.#findFirst(ctx, BodyContext);
        if (body?.start === null || body?.start === undefined || body.start.line !== position.line) return { inline: null, below: text };
        const eol = text.search(/\r?\n/u);
        if (eol === -1) return { inline: text, below: null };
        const below = text.slice(eol).replace(/^\r?\n/u, "");
        return { inline: text.slice(0, eol), below: below === "" ? null : below };
    }

    static #liftMatcher(op: string, metadata: SchemeMetadata, position: Position, raw: string | null = null, inline = false, carriedScope = false): { matcher: MatcherBody | null; metadata: SchemeMetadata; aside: string | null; scope: string | null } {
        if (metadata === null || metadata.length !== 1) {
            const bare = AstBuilder.#bareMatcher(raw, op, inline, position, { scope: carriedScope, metadata: metadata !== null });
            return bare === null
                ? { matcher: null, metadata, aside: null, scope: null }
                : {
                    matcher: AstBuilder.#parseMatcherBody(bare.text, position),
                    metadata: metadata ?? (bare.metadata === null ? null : [bare.metadata]),
                    aside: bare.aside,
                    scope: bare.scope,
                };
        }
        let parsed: unknown;
        try { parsed = JSON.parse(`[${metadata[0]}]`); }
        catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            return { matcher: null, metadata, aside: null, scope: null };
        }
        const elements = parsed as unknown[];
        if (elements.some((element) => typeof element !== "object" || element === null || Array.isArray(element))) {
            return { matcher: null, metadata, aside: null, scope: null };
        }
        const options = Object.assign({}, ...elements as object[]) as Record<string, unknown>;
        if (!Object.hasOwn(options, "pattern")) return { matcher: null, metadata, aside: null, scope: null };
        const pattern = options.pattern;
        if (typeof pattern !== "string") {
            throw new PlurnkParseError(position.line, position.column, "visitor", `${op} "pattern" must be a string matcher, e.g. [{"pattern": "/needle/i"}].`);
        }
        const matcher = AstBuilder.#parseMatcherBody(pattern, position);
        const others = Object.keys(options).filter((key) => key !== "pattern");
        return { matcher, metadata: others.length === 0 ? null : metadata, aside: null, scope: null };
    }

    // {§matcher-option} — a text or log operation's body is never a matcher; it is ignored with one
    // advisory naming the option form, and the operation still runs (operator, 2026-09-12: warn, never
    // strike, over a body the model was taught not to write).
    static #adviseBody(op: string, raw: string | null, position: Position): void {
        if (raw === null || raw.trim() === "") return;
        if (AstBuilder.#bareMatcher(raw, op, false) !== null) return;
        AstBuilder.#advisories.push(new PlurnkParseError(
            position.line, position.column, "parser",
            `${op} takes no body; the body was ignored. A pattern belongs on the opening fence line after the path.`,
            "warning",
        ));
    }

    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
    // Compile-only RFC 9535 admission using the runtime's JSONPath engine. {§matcher-prefix-claims}
    static #JSONPATH = new JSONPathEnvironment();
    static #GRAPH_MATCHER = /^&[<>]?[^\s<>]\S*$/u;

    static build(ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext): PlurnkStatement {
        // Disposition and SEND contexts can arrive without a statement wrapper.
        if (ctx instanceof DispositionStatementContext) return AstBuilder.#buildDisposition(ctx);
        if (ctx instanceof SendStatementContext) return AstBuilder.#buildSend(ctx);
        const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
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
        if ("dispositionStatement" in ctx) {
            const disposition = ctx.dispositionStatement(); if (disposition) return AstBuilder.#buildDisposition(disposition);
        }
        throw new Error("statement context has no recognized alternative");
    }

    static #buildFind(ctx: FindStatementContext): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const bodied = AstBuilder.#asideBody("FIND", AstBuilder.#asideOf(ctx), split.below, position);
        return AstBuilder.#buildFindFrom(ctx, bodied.aside, split.inline, bodied.raw);
    }

    static #buildFindFrom(ctx: FindStatementContext, aside: string | null, inline: string | null, below: string | null): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSlots(ctx.slotModifiers(), position);
        AstBuilder.#adviseBody("FIND", below, position);
        const lifted = AstBuilder.#liftMatcher("FIND", slots.metadata, position, inline ?? below, inline !== null, slots.lineMarker !== null);
        return {
            op: "FIND",
            aside: aside ?? lifted.aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : AstBuilder.#parseLineMarker(lifted.scope)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: null,
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
        throw new Error("clientStatement context has no recognized alternative");
    }

    // LOOK is the client-tier matcher observation. It shares the tag slots and parses
    // its matcher body directly for its client-owned lifecycle.
    static #buildLook(ctx: LookStatementContext): LookStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "LOOK",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildRead(ctx: ReadStatementContext): ReadStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const bodied = AstBuilder.#asideBody("READ", AstBuilder.#asideOf(ctx), split.below, position);
        AstBuilder.#adviseBody("READ", bodied.raw, position);
        const lifted = AstBuilder.#liftMatcher("READ", slots.metadata, position, split.inline ?? bodied.raw, split.inline !== null, slots.lineMarker !== null);
        const aside = bodied.aside ?? lifted.aside;
        // {§read-find-normalization} — a READ is never rewritten: a glob target is the runtime's
        // fan-out over every matching path, with or without a matcher (core {§read-fan-out}).
        return {
            op: "READ",
            aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : AstBuilder.#parseTextLineMarker(lifted.scope, position)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: null,
            position,
        };
    }

    static #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        // {§naked-pattern} — a sigil on the heading line is the matcher; the lines beneath are the
        // replacement (none deletes each match). Any other heading-line text is the body it always was.
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const lifted = AstBuilder.#liftMatcher("EDIT", slots.metadata, position, split.inline, true, slots.lineMarker !== null);
        return {
            op: "EDIT",
            aside: AstBuilder.#asideOf(ctx) ?? lifted.aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : AstBuilder.#parseTextLineMarker(lifted.scope, position)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: lifted.matcher === null || split.inline === null ? AstBuilder.#bodyTextOf(ctx) : split.below,
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
            aside: AstBuilder.#asideOf(ctx),
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
            aside: AstBuilder.#asideOf(ctx),
            source: AstBuilder.#resourceSelectionFromCtx(selections[0]!, position),
            destination: AstBuilder.#resourceSelectionFromCtx(selections[1]!, position),
            position,
        };
    }

    static #buildDisposition(ctx: DispositionStatementContext): DispositionStatement {
        const position = AstBuilder.#positionOf(ctx);
        const op = (ctx.start?.text ?? "").replace(/^`+[0-9]*/, "");
        if (!TurnDisposition.isOp(op)) throw new Error(`Unknown disposition operation: ${op}`);
        // {§one-line-turn} — an inventory written as a block on the heading line is the body when
        // nothing sits beneath the heading, with one advisory naming where it belongs.
        const below = AstBuilder.#bodyTextOf(ctx);
        const inline = ctx.metadata()?.getText() ?? null;
        if (inline !== null && (below === null || below.trim() === "")) {
            AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser",
                `${op}'s inventory was read from the heading line; it belongs in the body.`, "warning"));
        }
        const raw = below !== null && below.trim() !== "" ? below : inline;
        return {
            op,
            aside: AstBuilder.#asideOf(ctx),
            target: null,
            metadata: null,
            lineMarker: AstBuilder.#lineMarkerFromCtx(ctx.lineMarker()),
            body: PlanValue.admit(raw ?? "", (message) => AstBuilder.#advisories.push(
                new PlurnkParseError(position.line, position.column, "visitor", message, "warning"),
            )),
            position,
        };
    }

    // A mid-turn SEND is a message to its recipient path, or to the user when it names none.
    static #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSlots(ctx.resourceSelection(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    static #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractExecSlots(ctx.execModifiers(), position, AstBuilder.#executorOf(ctx) ?? "sh");
        return {
            op: "EXEC",
            aside: AstBuilder.#asideOf(ctx),
            executor: AstBuilder.#executorOf(ctx),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    // {§executor-case} — the AST carries the registered spelling; the tag may be written in any case.
    static executorSpellings: ReadonlyMap<string, string> = new Map();

    static #executorOf(ctx: ExecStatementContext): string | null {
        const name = ctx.OPEN_EXEC().getText().replace(/^`+[0-9]*/, "");
        if (name === "EXEC") return null;
        return AstBuilder.executorSpellings.get(name.toLowerCase()) ?? name;
    }

    static #buildBare(ctx: BareStatementContext): BareStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
        return {
            op: "BARE",
            aside: AstBuilder.#asideOf(ctx),
            target: slots.target,
            metadata: slots.metadata,
            lineMarker: null,
            body: AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        // {§kill-scope} — the scope names lines of a log body or of an entry; null kills the whole target.
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        AstBuilder.#adviseBody("KILL", split.below, position);
        const lifted = AstBuilder.#liftMatcher("KILL", slots.metadata, position, split.inline ?? split.below, split.inline !== null, slots.lineMarker !== null);
        return {
            op: "KILL",
            aside: AstBuilder.#asideOf(ctx) ?? lifted.aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : AstBuilder.#parseTextLineMarker(lifted.scope, position)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: null,
            position,
        };
    }

    static #buildWork(ctx: WorkStatementContext): WorkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
        return {
            op: "WORK",
            aside: AstBuilder.#asideOf(ctx),
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
            aside: AstBuilder.#asideOf(ctx),
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

    static #singleMarker(ctx: ParserRuleContext | null, pos: Position): LineMarkerContext | null {
        const found = AstBuilder.#findAll(ctx, LineMarkerContext);
        if (found.length > 1) throw new PlurnkParseError(pos.line, pos.column, "visitor", "A resource selection takes at most one scope.");
        return found[0] ?? null;
    }

    static #extractSlots(modCtx: SlotModifiersContext | ResourceSelectionContext | null, pos: Position): Slots {
        return {
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#singleMarker(modCtx, pos)),
        };
    }

    static #extractTextSlots(modCtx: SlotModifiersContext | null, pos: Position): TextSlots {
        return {
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: AstBuilder.#textLineMarkerFromCtx(AstBuilder.#singleMarker(modCtx, pos)),
        };
    }

    // Depth-first search for the first terminal of `tokenType`; returns its text or null.
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

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position, executor: string): Slots {
        // {§exec-executor-slot} — every slot at most once; the grammar admits any order.
        const once = <T extends ParserRuleContext>(type: Ctor<T>, slot: string): T | null => {
            const found = AstBuilder.#findAll(modCtx, type);
            if (found.length > 1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `${executor} accepts ${slot} at most once`);
            }
            return found[0] ?? null;
        };
        return {
            target: AstBuilder.#targetFromCtx(once(TargetContext, "one `(program)` path"), pos),
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
        const nestedScope = ctx.lineMarker();
        if (nestedScope !== null) {
            const point = AstBuilder.#positionOf(nestedScope);
            AstBuilder.#advisories.push(new PlurnkParseError(
                point.line, point.column, "parser",
                "The scope was inside the target slot; it was applied as the operation scope.",
                "warning",
            ));
        }
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
        const lifted = AstBuilder.#liftMatcher("COPY/MOVE", AstBuilder.#metadataFromCtx(ctx), pos);
        return {
            target,
            metadata: lifted.metadata,
            lineMarker: AstBuilder.#textLineMarkerFromCtx(AstBuilder.#singleMarker(ctx, pos)),
            matcher: lifted.matcher,
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
        return AstBuilder.#parseTextLineMarker(text, AstBuilder.#positionOf(ctx));
    }

    static #parseTextLineMarker(text: string, position?: Position): TextLineMarker {
        if (!text.includes("@")) return AstBuilder.#parseLineMarker(text);
        const marks = text.slice(1, -1).split(/, ?/).map((component) => {
            // {§anchor-digits} — `@210` is the line number 210 with the anchor's sigil, not a hash.
            if (/^@[0-9]{1,4}$/u.test(component)) {
                if (position !== undefined) {
                    AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser",
                        `\`${component}\` was read as line ${component.slice(1)}; an anchor is five characters (\`@abcde\`).`, "warning"));
                }
                return Number.parseInt(component.slice(1), 10);
            }
            // {§combined-anchor-tolerance} — `@abcde 42` / `@abcde:42` is the displayed prefix copied whole;
            // the anchor is the coordinate and the number is dropped.
            const combined = /^(@[0-9A-Za-z]{5})[: ][1-9][0-9]*$/u.exec(component);
            if (combined !== null) {
                if (position !== undefined) {
                    AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser",
                        `\`${component}\` was read as the anchor \`${combined[1]}\`; a scope position takes the anchor without its displayed line number.`, "warning"));
                }
                return combined[1]!;
            }
            return component.startsWith("@") ? component : Number.parseFloat(component);
        });
        return { marks: marks as [number | string, ...(number | string)[]] };
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #asideOf(ctx: ParserRuleContext): string | null {
        const token = AstBuilder.#findToken(ctx, plurnkLexer.ASIDE);
        if (token === null) return null;
        const inner = token.endsWith("-->") ? token.slice("<!--".length, -"-->".length) : token.slice("<!--".length);
        return inner.trim();
    }

    // {§closer-fallback} — without a real closer (the block ended at the next heading or at the end
    // of the input) the body is cut back to its last bare fence line, which is the closer the model
    // meant, and one terminating line ending goes with it. A synthetic SECTION_END carries no backtick.
    static #bodyTextOf(ctx: ParserRuleContext): string | null {
        const text = AstBuilder.#findFirst(ctx, BodyContext)?.getText() ?? null;
        if (text === null) return null;
        const closer = AstBuilder.#findToken(ctx, plurnkLexer.SECTION_END);
        if (closer !== null && closer.includes("`")) return text;
        const lines = text.split("\n");
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (/^[ \t]*`{3,}[0-9]*[ \t]*\r?$/u.test(lines[index] ?? "")) {
                const kept = lines.slice(0, index).join("\n");
                return kept === "" ? null : kept;
            }
        }
        const trimmed = text.replace(/\r?\n$/u, "");
        return trimmed === "" ? null : trimmed;
    }

    static #requiredBodyTextOf(ctx: ParserRuleContext): string {
        return AstBuilder.#bodyTextOf(ctx) ?? "";
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
            // {§local-path-fragment} — `#channel` after a bare path is the channel, exactly as on a
            // URL; a spelling that opens with `#` names no path, so it stays whole.
            const hash = target.indexOf("#");
            if (hash < 1) return { kind: "local", raw: target };
            return { kind: "local", raw: target.slice(0, hash), fragment: target.slice(hash + 1) };
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
                `Matcher has ${lineCount} lines; expected 1.`,
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
        // {§naked-pattern} — a matcher opening with `^` is a regex written without slashes or flags.
        if (raw.startsWith("^")) {
            const inline = AstBuilder.#liftInlineFlags(raw.slice(1), "", pos);
            const pattern = `^${inline.pattern}`;
            try { new RegExp(pattern, inline.flags); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`^\` but is not a valid regex - ${AstBuilder.#detail(e)}`);
            }
            return { dialect: "regex", raw, pattern, flags: inline.flags };
        }
        if (raw.startsWith("/")) {
            const regex = AstBuilder.#tryParseSlashRegex(raw, pos);
            if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
            if (regex.reason === "trailing") {
                throw new PlurnkParseError(
                    pos.line,
                    pos.column,
                    "visitor",
                    "Regex matcher has trailing text after `/pattern/flags`.",
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
        if (raw.startsWith("~")) return { dialect: "fts", raw };
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
    // {§inline-flag-tolerance} — a leading PCRE inline modifier such as `(?i)` is the pretrained
    // spelling of a flag; ECMAScript refuses the group, so it is lifted into the flags with one
    // advisory rather than refused.
    static #liftInlineFlags(pattern: string, flags: string, pos: Position): { pattern: string; flags: string } {
        const inline = /^\(\?([ims]+)\)/u.exec(pattern);
        if (inline === null) return { pattern, flags };
        const lifted = [...new Set([...flags, ...inline[1]!])].join("");
        AstBuilder.#advisories.push(new PlurnkParseError(pos.line, pos.column, "parser",
            `\`${inline[0]}\` was read as the \`${inline[1]}\` flag; an ECMAScript regex takes its flags after the closing \`/\`.`, "warning"));
        return { pattern: pattern.slice(inline[0].length), flags: lifted };
    }

    static #tryParseSlashRegex(raw: string, pos: Position):
        { ok: true; pattern: string; flags: string }
        | { ok: false; reason: "unclosed" }
        | { ok: false; reason: "trailing" }
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
        const authored = raw.slice(i + 1);
        const trailing = /^([A-Za-z]*)[\t ]/u.exec(authored);
        const inline = AstBuilder.#liftInlineFlags(raw.slice(1, i), trailing?.[1] ?? authored, pos);
        const { pattern, flags } = inline;
        try { new RegExp(pattern, flags); }
        catch (e) { return { ok: false, reason: "invalid", detail: AstBuilder.#detail(e), flags }; }
        if (trailing !== null) return { ok: false, reason: "trailing" };
        return { ok: true, pattern, flags };
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
