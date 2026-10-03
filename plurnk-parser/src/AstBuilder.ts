import { ParserRuleContext, TerminalNode } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPathEnvironment } from "json-p3";
import type {
    BareStatement,
    ClientStatement,
    CopyStatement,
    EditStatement,
    ExecStatement,
    RuntimeTag,
    FindStatement,
    KillStatement,
    WorkStatement,
    ForkStatement,
    LineMarker,
    LookStatement,
    MatcherBody,
    MoveStatement,
    NoteStatement,
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
} from "@plurnk/plurnk-contracts";
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
    NoteStatementContext,
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
import { PathSyntax, PlurnkParseError, TurnDisposition } from "@plurnk/plurnk-contracts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type SchemeMetadata = string[] | null;
type Slots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: LineMarker | null };
type TextSlots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: TextLineMarker | null };

export default class AstBuilder {
    // {§error-shape}: advisories belong only to the statement that was built successfully.
    static #advisories: PlurnkParseError[] = [];

    static collectAdvisories<T>(build: () => T): { value: T; advisories: PlurnkParseError[] } {
        const previous = AstBuilder.#advisories;
        AstBuilder.#advisories = [];
        try {
            const value = build();
            return { value, advisories: AstBuilder.#advisories };
        } finally {
            AstBuilder.#advisories = previous;
        }
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
            // {§log-heading-notation} — a trailing ` · N` is the log's token charge, never part of the matcher.
            const charge = /\s+(\u00B7[ \t]*(?:[0-9]+(?:[ \t]+tokens)?)?)\s*$/u.exec(text);
            if (charge !== null && charge.index > 0) {
                text = text.slice(0, charge.index).trim();
                AstBuilder.#adviseTrailing(position, AstBuilder.chargeAdvisory(charge[1]!));
                continue;
            }
            const note: { matcher: string; aside: string } | null = aside === null ? AstBuilder.#dotNote(text) : null;
            if (note !== null) {
                aside = note.aside;
                text = note.matcher;
                AstBuilder.#adviseTrailing(position, AstBuilder.dotAsideAdvisory(note.aside));
                continue;
            }
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
        // {§heading-slot-order} — a sigil pattern quoted in single backticks is that pattern (#758).
        const ticked = /^`([^`]+)`$/u.exec(text);
        if (ticked !== null && AstBuilder.#SIGIL.test(ticked[1]!)) text = ticked[1]!;
        if (AstBuilder.#SIGIL.test(text)) return { text, aside, scope, metadata };
        if (!inline || (op !== "FIND" && op !== "READ" && op !== "KILL")) return null;
        // {§bare-option-object} — here the same text is the matcher; a JSON object is named, so the
        // collision with the option form is learned in the turn it happens.
        if (metadataFree && text.startsWith("{") && AstBuilder.#isJsonObject(text)) AstBuilder.#adviseTrailing(position, "`{…}` was read as the matcher; an option block is `[{…}]`.");
        return { text, aside, scope, metadata };
    }

    static #adviseTrailing(position: Position | undefined, message: string): void {
        if (position === undefined) return;
        AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser", message, "warning"));
    }

    // {§log-heading-notation} — the receipts that name the log's heading notation where a model wrote it.
    static chargeAdvisory(written: string): string {
        return written.trim() === "\u00B7"
            ? "`\u00B7` is how the log separates a heading from its token charge; it is not part of an operation and was ignored."
            : `\`${written.trim()}\` is the token charge the log shows on a heading; it is not part of an operation and was ignored.`;
    }

    static dotAsideAdvisory(aside: string): string {
        return `\`\u00B7 ${aside}\` was read as the aside; a note on an operation is written \`<!-- ${aside} -->\`.`;
    }

    // `/pattern/flags · words`: a closed regex, then a middle-dot note, which is the aside.
    static #dotNote(text: string): { matcher: string; aside: string } | null {
        if (!text.startsWith("/") || text.startsWith("//")) return null;
        const close = AstBuilder.#regexClose(text);
        if (close === -1) return null;
        const note = /^([A-Za-z]*)\s+\u00B7[ \t]*(\S.*)$/u.exec(text.slice(close + 1));
        if (note === null) return null;
        return { matcher: text.slice(0, close + 1 + note[1]!.length), aside: note[2]!.trim() };
    }

    // The index of the slash that closes a `/pattern/` regex, or -1: escapes and character classes hold slashes.
    static #regexClose(raw: string): number {
        let inClass = false;
        for (let i = 1; i < raw.length; i++) {
            if (raw[i] === "\\") { i++; continue; }
            if (raw[i] === "[") inClass = true;
            else if (raw[i] === "]" && inClass) inClass = false;
            else if (raw[i] === "/" && !inClass) return i;
        }
        return -1;
    }

    // {§bare-target} — a target written without its parentheses, `READ a.py <1,4>`, stands where the
    // target goes. FIND, READ and EDIT cannot run without one, so the refusal writes the line that does.
    static #bareTarget(op: string, target: ParsedPath | null, inline: string | null, position: Position): void {
        if (target !== null || inline === null) return;
        const text = inline.trim();
        if (text === "" || AstBuilder.#SIGIL.test(text) || /^[<[`{\u00B7]/u.test(text)) return;
        const word = text.split(/\s/u, 1)[0]!;
        const rest = text.slice(word.length).trim();
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `\`${op}\` has no target: \`${word}\` stands where the target goes.`, "error",
            `Write the target in parentheses: \`${op} (${word})${rest === "" ? "" : ` ${rest}`}\`.`);
    }

    static #isJsonArrayOfObjects(inner: string): boolean {
        return AstBuilder.metadataOptions([inner]) !== null;
    }

    static #isJsonObject(text: string): boolean {
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            return false;
        }
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    }

    // {§bare-option-object} — one JSON object where the option block goes, on an operation that takes
    // options and no bare matcher: read as `[{…}]`, so every consumer sees the taught shape. The receipt
    // names the indulgence once, in place of the inline-body advisory the lexer withheld.
    static #liftBareOptionObject(tag: string, metadata: SchemeMetadata, split: { inline: string | null; below: string | null }, position: Position): { metadata: SchemeMetadata; lifted: boolean } {
        if (metadata !== null || split.inline === null || !AstBuilder.#isJsonObject(split.inline.trim())) return { metadata, lifted: false };
        AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser", `\`${tag}\` took a bare option object; the taught form is \`[{…}]\`.`, "warning"));
        return { metadata: [split.inline.trim()], lifted: true };
    }

    // {§bare-option-object}: for an executor whose declared body is JSON, a bare heading object is that body,
    // written on the wrong line; the lexer withheld the inline-body advisory, so name the form here.
    static #inlineObjectBody(tag: string, metadata: SchemeMetadata, split: { inline: string | null; below: string | null }, position: Position): { metadata: SchemeMetadata; lifted: boolean } {
        if (metadata === null && split.inline !== null && AstBuilder.#isJsonObject(split.inline.trim())) {
            AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser", `\`${tag}\` took its body on the heading line; the body belongs on the lines below it.`, "warning"));
        }
        return { metadata, lifted: false };
    }

    // {§matcher-option} — shared by admission and rendering; invalid blocks remain owner input.
    static metadataOptions(metadata: readonly string[] | null | undefined): Record<string, unknown> | null {
        if (metadata?.length !== 1) return null;
        let parsed: unknown;
        try { parsed = JSON.parse(`[${metadata[0]}]`); }
        catch (cause) {
            if (!(cause instanceof SyntaxError)) throw cause;
            return null;
        }
        if (!Array.isArray(parsed) || parsed.some((element) => typeof element !== "object" || element === null || Array.isArray(element))) return null;
        return Object.assign({}, ...parsed as object[]) as Record<string, unknown>;
    }

    static readonly #SIGIL = /^(\/|\$|~|&|\^)/u;
    // The scope shapes the lexer admits, matched at the right end of the heading text.
    static readonly #TAIL_POSITIONS = /\s*(<-?[0-9]+(?:\.[0-9]+)?(?:(?:,\s?|-)-?[0-9]+(?:\.[0-9]+)?)*>)\s*$/u;
    static readonly #TAIL_TEXT_SCOPE = /\s*(<(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}|@[0-9]{1,4})(?:(?:,\s?|-)(?:-?[0-9]+(?:\.[0-9]+)?|@[0-9A-Za-z]{5}|@[0-9]{1,4}))*>)\s*$/u;

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

    static #liftMatcher(op: string, metadata: SchemeMetadata, position: Position, raw: string | null = null, inline = false, carriedScope = false, target: ParsedPath | null = null): { matcher: MatcherBody | null; metadata: SchemeMetadata; aside: string | null; scope: string | null } {
        const options = AstBuilder.metadataOptions(metadata);
        if (options === null || !Object.hasOwn(options, "pattern")) {
            const bare = AstBuilder.#bareMatcher(raw, op, inline, position, { scope: carriedScope, metadata: metadata !== null });
            return bare === null
                ? { matcher: null, metadata, aside: null, scope: null }
                : {
                    matcher: AstBuilder.#parseMatcherBody(bare.text, position, target),
                    metadata: metadata ?? (bare.metadata === null ? null : [bare.metadata]),
                    aside: bare.aside,
                    scope: bare.scope,
                };
        }
        const pattern = options.pattern;
        if (typeof pattern !== "string") {
            throw new PlurnkParseError(position.line, position.column, "visitor", `${op} "pattern" must be a string matcher.`, "error",
                `Write the matcher as a string, \`[{"pattern": "/needle/i"}]\`, or bare on the opening fence line after the path.`);
        }
        const matcher = AstBuilder.#parseMatcherBody(pattern, position, target);
        const others = Object.keys(options).filter((key) => key !== "pattern");
        return { matcher, metadata: others.length === 0 ? null : metadata, aside: null, scope: null };
    }

    // {§matcher-option} — a text or log operation's body is never a matcher; it is ignored with one
    // advisory naming the option form, and the operation still runs ({§matcher-body-redirect}: warn,
    // never strike).
    static #adviseBody(op: string, raw: string | null, position: Position): void {
        if (raw === null || raw.trim() === "") return;
        if (AstBuilder.#bareMatcher(raw, op, false) !== null) return;
        AstBuilder.#advisories.push(new PlurnkParseError(
            position.line, position.column, "parser",
            `${op === "KILL" ? "KILL with a target" : op} takes no body; the body was ignored. A pattern belongs on the opening fence line after the path.`,
            "warning",
        ));
    }

    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
    // Compile-only RFC 9535 admission using the runtime's JSONPath engine. {§matcher-prefix-claims}
    static #JSONPATH = new JSONPathEnvironment();
    static #GRAPH_MATCHER = /^&[<>]?[^\s<>]\S*$/u;

    static build(ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext): PlurnkStatement {
        const statement = AstBuilder.#buildAny(ctx);
        // {§naked-operation} — the name alone opened it; the receipt names the taught form, once.
        const opener = ctx.start?.text ?? "";
        if (opener.length > 0 && !opener.startsWith("`")) {
            AstBuilder.#advisories.push(new PlurnkParseError(ctx.start!.line, ctx.start!.column, "parser", `\`${opener}\` opened with no fence; the taught form is three backticks.`, "warning"));
            return AstBuilder.#withoutNakedCloser(statement);
        }
        return statement;
    }

    // {§naked-operation} — a naked block expects no closer, so a closer the author wrote anyway is still its last
    // line: a final bare fence that no fence in the body opened is that closer, not part of the body.
    static #withoutNakedCloser(statement: PlurnkStatement): PlurnkStatement {
        if (!("body" in statement) || statement.body === null) return statement;
        const raw = typeof statement.body === "string" ? statement.body : statement.body.raw;
        const lines = raw.split("\n");
        const fences = lines.filter((line) => /^ {0,3}`{3,}/u.test(line)).length;
        if (fences % 2 === 0 || !/^ {0,3}`{3,}[ \t\r]*$/u.test(lines.at(-1)!)) return statement;
        const kept = lines.slice(0, -1).join("\n").replace(/\r?\n$/u, "");
        const body = kept === "" ? null : kept;
        if (statement.op === "SEND") return { ...statement, body: body === null ? null : AstBuilder.#parseSendBody(body) };
        return { ...statement, body } as PlurnkStatement;
    }

    static #buildAny(ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext): PlurnkStatement {
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
        const note = ctx.noteStatement(); if (note) return AstBuilder.#buildNote(note);
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
        AstBuilder.#bareTarget("FIND", slots.target, inline, position);
        AstBuilder.#adviseBody("FIND", below, position);
        const lifted = AstBuilder.#liftMatcher("FIND", slots.metadata, position, inline ?? below, inline !== null, slots.lineMarker !== null, slots.target);
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
        AstBuilder.#bareTarget("READ", slots.target, split.inline, position);
        const bodied = AstBuilder.#asideBody("READ", AstBuilder.#asideOf(ctx), split.below, position);
        AstBuilder.#adviseBody("READ", bodied.raw, position);
        const lifted = AstBuilder.#liftMatcher("READ", slots.metadata, position, split.inline ?? bodied.raw, split.inline !== null, slots.lineMarker !== null, slots.target);
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
        AstBuilder.#bareTarget("EDIT", slots.target, split.inline, position);
        const lifted = AstBuilder.#liftMatcher("EDIT", slots.metadata, position, split.inline, true, slots.lineMarker !== null, slots.target);
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
        const target = AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), position);
        const durations = AstBuilder.#findAll(ctx, LineMarkerContext)
            .map((marker) => AstBuilder.#lineMarkerFromCtx(marker)!.marks[0]!)
            .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
        return {
            op,
            aside: AstBuilder.#asideOf(ctx),
            target,
            metadata: null,
            // {§send-wait-scope} Repeated duration bounds compose as their earliest wake.
            lineMarker: durations.length === 0 ? null : { marks: [Math.min(...durations)] },
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildNote(ctx: NoteStatementContext): NoteStatement {
        return {
            op: "NOTE", aside: AstBuilder.#asideOf(ctx), target: null, metadata: null, lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx), position: AstBuilder.#positionOf(ctx),
        };
    }

    // A mid-turn SEND is a message to its recipient path, or to the user when it names none.
    static #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractSlots(ctx.resourceSelection(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = AstBuilder.#liftBareOptionObject("SEND", AstBuilder.#metadataFromCtx(ctx), split, position);
        const raw = options.lifted ? split.below : AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    static #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const runtime = AstBuilder.#executorOf(ctx);
        const slots = AstBuilder.#extractExecSlots(ctx.execModifiers(), position, runtime);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        // {§bare-option-object}: the option-array shape is the house convention; an executor whose declared body is
        // JSON (an MCP tool's arguments) reads a bare heading object as that body.
        const options = AstBuilder.jsonBodyExecutors.has(runtime)
            ? AstBuilder.#inlineObjectBody(runtime, slots.metadata, split, position)
            : AstBuilder.#liftBareOptionObject(runtime, slots.metadata, split, position);
        return {
            runtime,
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            body: options.lifted ? split.below : AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    // {§executor-case} — the AST carries the registered spelling; the tag may be written in any case.
    static executorSpellings: ReadonlyMap<string, string> = new Map();
    // {§bare-option-object} — per parse: the executors whose declared body is JSON.
    static jsonBodyExecutors: ReadonlySet<string> = new Set();

    static #executorOf(ctx: ExecStatementContext): RuntimeTag {
        const name = ctx.OPEN_EXEC().getText().replace(/^`+[0-9]*/, "").toLowerCase();
        return (AstBuilder.executorSpellings.get(name) ?? name) as RuntimeTag;
    }

    static #buildBare(ctx: BareStatementContext): BareStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = AstBuilder.#liftBareOptionObject("BARE", slots.metadata, split, position);
        return {
            op: "BARE",
            aside: AstBuilder.#asideOf(ctx),
            target: slots.target,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        // {§kill-scope} — the scope names lines of a log body or of an entry; null kills the whole target.
        const slots = AstBuilder.#extractTextSlots(ctx.slotModifiers(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        if (slots.target === null && slots.lineMarker === null && slots.metadata === null) {
            return {
                op: "KILL", aside: AstBuilder.#asideOf(ctx), ...slots, matcher: null,
                body: AstBuilder.#bodyTextOf(ctx), position,
            };
        }
        AstBuilder.#adviseBody("KILL", split.below, position);
        const lifted = AstBuilder.#liftMatcher("KILL", slots.metadata, position, split.inline ?? split.below, split.inline !== null, slots.lineMarker !== null, slots.target);
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
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = AstBuilder.#liftBareOptionObject("WORK", slots.metadata, split, position);
        return {
            op: "WORK",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : AstBuilder.#requiredBodyTextOf(ctx),
            position,
        };
    }

    static #buildFork(ctx: ForkStatementContext): ForkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = AstBuilder.#liftBareOptionObject("FORK", slots.metadata, split, position);
        return {
            op: "FORK",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : AstBuilder.#requiredBodyTextOf(ctx),
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
        if (found.length > 1) {
            const written = found.map((marker) => `\`${marker.getText()}\``);
            throw new PlurnkParseError(pos.line, pos.column, "visitor",
                `A resource selection takes one scope, and ${written.join(" and ")} both stand here.`, "error",
                `Write one scope, such as ${written.at(-1)}.`);
        }
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
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `${executor} accepts ${slot} at most once`, "error",
                    `Write ${slot} on the \`${executor}\` heading, and the rest below it as the input.`);
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
        // {§log-heading-notation} — `→ path` names the target as the log's heading shows it.
        const arrow = ctx.ARROW_TARGET();
        const text = arrow !== null ? arrow.getText().replace(/^\u2192[ \t]*/u, "") : ctx.TARGET_TEXT().map((token) => token.getText()).join("");
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
        const lifted = AstBuilder.#liftMatcher("COPY/MOVE", AstBuilder.#metadataFromCtx(ctx), pos, null, false, false, target);
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

    static #parseTextLineMarker(marker: string, position?: Position): TextLineMarker {
        // {§combined-anchor-tolerance} — `42<@abcde>` is the displayed row prefix copied whole: the
        // scope is the anchor, the digits are dropped, and one advisory names the anchor-only form.
        const prefixed = /^([1-9][0-9]*)(<[\s\S]*)$/u.exec(marker);
        const text = prefixed === null ? marker : prefixed[2]!;
        if (prefixed !== null && position !== undefined) {
            AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser",
                `\`${marker}\` was read as the scope \`${text}\`; a scope takes the anchor without its displayed line number.`, "warning"));
        }
        if (!text.includes("@")) {
            // {§anchor-offset} — a bare `+N` counts only from an anchor (#749).
            if (/[<,] ?\+/u.test(text)) {
                throw new PlurnkParseError(position?.line ?? 0, position?.column ?? 0, "visitor",
                    `invalid scope ${JSON.stringify(text)}; use numeric coordinates or \`@hash\` line anchors`, "error", AstBuilder.#OFFSET_RECOVERY);
            }
            return AstBuilder.#parseLineMarker(text);
        }
        const marks = text.slice(1, -1).split(/, ?/).map((component) => {
            // {§anchor-digits} — `@210` is the line number 210 with the anchor's sigil, not a hash.
            if (/^@[0-9]{1,4}$/u.test(component)) {
                if (position !== undefined) {
                    AstBuilder.#advisories.push(new PlurnkParseError(position.line, position.column, "parser",
                        `\`${component}\` was read as line ${component.slice(1)}; an anchor is five characters (\`@abcde\`).`, "warning"));
                }
                return Number.parseInt(component.slice(1), 10);
            }
            return component.startsWith("@") ? component : Number.parseFloat(component);
        });
        // {§anchor-offset} — a bare `+N` counts from the anchor before it (`<@abcde,+1>`); anywhere
        // else it names no line, so the scope is refused as before (#749).
        const components = text.slice(1, -1).split(/, ?/);
        for (const [index, component] of components.entries()) {
            if (!component.startsWith("+")) continue;
            const base = /^(@[0-9A-Za-z]{5})([+-][0-9]+)?$/u.exec(String(marks[index - 1] ?? ""));
            if (base === null) {
                throw new PlurnkParseError(position?.line ?? 0, position?.column ?? 0, "visitor",
                    `invalid scope ${JSON.stringify(text)}; use numeric coordinates or \`@hash\` line anchors`, "error", AstBuilder.#OFFSET_RECOVERY);
            }
            const offset = Number(base[2] ?? 0) + Number(component.slice(1));
            marks[index] = offset === 0 ? base[1]! : `${base[1]!}${offset > 0 ? "+" : ""}${offset}`;
        }
        return { marks: marks as [number | string, ...(number | string)[]] };
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #asideOf(ctx: ParserRuleContext): string | null {
        const token = AstBuilder.#findToken(ctx, plurnkLexer.ASIDE);
        if (token === null) return null;
        // {§log-heading-notation} — ` · words` after the slots is the aside.
        if (token.startsWith("\u00B7")) return token.slice(1).trim();
        const inner = token.endsWith("-->") ? token.slice("<!--".length, -"-->".length) : token.slice("<!--".length);
        return inner.trim();
    }

    // {§fence-pairing} — a block that ends without a closer of its own (a supplied closer, at the next
    // heading or at the end of the input) keeps its whole body: FencePairing has already decided which
    // fence lines inside it are content. One terminating line ending goes with it. A synthetic
    // SECTION_END carries no backtick.
    static #bodyTextOf(ctx: ParserRuleContext): string | null {
        const text = AstBuilder.#findFirst(ctx, BodyContext)?.getText() ?? null;
        if (text === null) return null;
        const closer = AstBuilder.#findToken(ctx, plurnkLexer.SECTION_END);
        if (closer !== null && closer.includes("`")) return text;
        const whole = text.replace(/\r?\n$/u, "");
        return whole === "" ? null : whole;
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
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "invalid URI in path", "error",
                "Write a local path, `(src/a.py)`, or a complete URL, `scheme://host/path`.");
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
        const queryStart = target.indexOf("?", authorityStart);
        const fragmentStart = target.indexOf("#", authorityStart);
        const endings = [queryStart, fragmentStart].filter((index) => index >= 0);
        const pathEnd = endings.length === 0 ? target.length : Math.min(...endings);
        if (pathStart >= pathEnd) return { value: target, restore: (pathname) => pathname };
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
        const fragmentStart = url.href.indexOf("#");
        if (fragmentStart !== -1 && fragmentStart < queryStart) return null;
        return url.href.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
    }

    // The leading prefix claims its dialect; failed claimed syntax never falls back
    // to glob. XPath's `//` is classified before regex `/`. {§matcher-prefix-claims}
    static readonly #OFFSET_RECOVERY = "Count from an anchor, `<@abcde,+1>`, or write line numbers, `<L,M>`.";

    // {§parse-recovery} — the working forms for a refused regex, in the model's terms: the regex that matches the
    // words it wrote, and, when the pattern is glob-shaped, the target glob that selects files by name.
    static #regexRecovery(inner: string, target: ParsedPath | null): string {
        const globShaped = /^[\w*?./ -]+$/u.test(inner) && /[*?]/u.test(inner);
        if (!globShaped) return "A pattern is a regex written `/pattern/flags`; escape a literal `*`, `+`, `?`, `(`, `[` or `.` with `\\`.";
        const words = inner.replace(/^[*?]+|[*?]+$/gu, "").trim();
        const core = words.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
        const repeats = inner.includes("?") ? "`*` and `?` repeat what precedes them" : "`*` repeats what precedes it";
        const regex = words === "" ? "A pattern is a regex: write `/needle/` to match lines containing needle" : `A pattern is a regex: write \`/${core}/\` to match lines containing ${words}`;
        const raw = target?.raw ?? "";
        const last = raw.split("/").at(-1) ?? "";
        const dir = raw === "" ? "" : /[*?[{]/u.test(last) || last.includes(".") ? raw.slice(0, raw.length - last.length) : `${raw}/`;
        return `${regex}; ${repeats}. To select files by name, put the glob in the target: \`FIND (${dir}${inner})\`.`;
    }

    static #parseMatcherBody(body: string, pos: Position, target: ParsedPath | null = null): MatcherBody {
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
                "error",
                "Write the pattern on one line, on the opening fence line after the path.",
            );
        }
        if (raw.startsWith("//")) {
            try { xpath.parse(raw); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`//\` but is not a valid xpath selector - ${AstBuilder.#detail(e)}`, "error",
                    "Write an XPath 1.0 selector after `//`, such as `//dependencies/*`; a text search is a regex, `/needle/`.");
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
                    `pattern leads with \`^\` but is not a valid regex - ${AstBuilder.#detail(e)}`, "error",
                    AstBuilder.#regexRecovery(raw.slice(1), target));
            }
            return { dialect: "regex", raw, pattern, flags: inline.flags };
        }
        if (raw.startsWith("/")) {
            const regex = AstBuilder.#tryParseSlashRegex(raw, pos);
            if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
            const range = AstBuilder.#sedRange(raw);
            if (range !== null) throw new PlurnkParseError(pos.line, pos.column, "visitor", range, "error", range.slice(range.indexOf("Match ")));
            if (regex.reason === "trailing") {
                throw new PlurnkParseError(
                    pos.line,
                    pos.column,
                    "visitor",
                    "Regex matcher has trailing text after `/pattern/flags`.",
                    "error",
                    "Write only `/pattern/flags` in the matcher; flags are optional.",
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
                regex.reason === "empty"
                    ? "`/` opens a regex matcher but no pattern follows it; write `/pattern/flags`, flags optional."
                    : `pattern leads with \`/\` but is not a valid \`/pattern/flags\` regex - ${regex.detail}${slashRecovery}: \`${excerpt}\``,
                "error",
                regex.reason === "empty" ? "Write `/pattern/flags`, flags optional, such as `/timeout/i`." : AstBuilder.#regexRecovery(raw.slice(1, raw.lastIndexOf("/") > 0 ? raw.lastIndexOf("/") : undefined), target));
        }
        if (raw.startsWith("$")) {
            // Compile-only RFC 9535 admission through the shared json-p3 engine.
            try { AstBuilder.#JSONPATH.compile(raw); }
            catch (e) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor",
                    `pattern leads with \`$\` but is not a valid jsonpath - ${AstBuilder.#detail(e)}`, "error",
                    "Write an RFC 9535 JSONPath after `$`, such as `$.items[?(@.price>500)]`; a text search is a regex, `/needle/`.");
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
                    "error",
                    "Write `&symbol` for a symbol, `&<symbol` for what calls it, or `&>symbol` for what it calls.",
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

    // {§regex-sed-range} — `/a/,/b/` and `/a/,+N` are sed line ranges, not flags; say what they are
    // and give the two-step form that addresses the same lines.
    static #sedRange(raw: string): string | null {
        const range = /^\/((?:\\.|[^\\/])+)\/\s*,\s*(?:\/((?:\\.|[^\\/])+)\/|\+(\d+))?\s*$/u.exec(raw);
        if (range === null) return null;
        const [, first, last, count] = range;
        const locate = last === undefined ? `/${first}/` : `/${first}|${last}/`;
        const scope = count === undefined ? "`<first,last>`" : `\`<N,M>\`, M being N + ${count}`;
        return `\`${raw}\` is a sed line range; a matcher is one regex and selects only the lines it matches, never the lines between matches. Match ${last === undefined ? "the start" : "both ends"} with \`${locate}\` to learn ${last === undefined ? "its line number" : "their line numbers"}, then address the span by scope: ${scope}.`;
    }

    static #tryParseSlashRegex(raw: string, pos: Position):
        { ok: true; pattern: string; flags: string }
        | { ok: false; reason: "empty" }
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
        if (i >= raw.length) {
            // {§unclosed-regex} — the heading's own boundaries make the rest the whole pattern.
            if (raw.length === 1) return { ok: false, reason: "empty" };
            const inline = AstBuilder.#liftInlineFlags(raw.slice(1), "", pos);
            try { new RegExp(inline.pattern, inline.flags); }
            catch (e) { return { ok: false, reason: "invalid", detail: AstBuilder.#detail(e), flags: inline.flags }; }
            const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
            AstBuilder.#advisories.push(new PlurnkParseError(pos.line, pos.column, "parser",
                `\`${excerpt}\` has no closing \`/\`; it was read as the whole pattern with no flags. A regex closes with \`/\` and takes its flags after it.`, "warning"));
            return { ok: true, pattern: inline.pattern, flags: inline.flags };
        }
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
