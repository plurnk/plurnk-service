import { ParserRuleContext, TerminalNode } from "antlr4ng";
import type {
    BareStatement,
    CopyStatement,
    DispositionStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    ForkStatement,
    KillStatement,
    LineMarker,
    MatcherBody,
    MoveStatement,
    NoteStatement,
    ParsedPath,
    PlurnkStatement,
    Position,
    ReadStatement,
    ResourceSelection,
    RuntimeTag,
    SendBody,
    SendStatement,
    TextLineMarker,
    WorkStatement,
} from "@plurnk/plurnk-contracts";
import type {
    BareStatementContext,
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    FirstResourceSelectionContext,
    ForkStatementContext,
    KillStatementContext,
    MidStatementContext,
    MoveStatementContext,
    NoteStatementContext,
    ReadStatementContext,
    ResourceSelectionContext,
    SlotModifiersContext,
    StatementContext,
    TargetGroupContext,
    TargetWithMetadataContext,
    WorkStatementContext,
} from "./generated/plurnkParser.ts";
import {
    BodyContext,
    DispositionStatementContext,
    LineMarkerContext,
    MetadataContext,
    SendStatementContext,
    TargetContext,
    plurnkParser,
} from "./generated/plurnkParser.ts";
import { PlurnkParseError, TurnDisposition } from "@plurnk/plurnk-contracts";
import { SIGIL, bareMatcher, isJsonObject, liftBareMatcher, liftMatcher } from "./MatcherSyntax.ts";
import { parseLineMarker, parseRangeMarker, parseTextLineMarker } from "./ScopeSyntax.ts";
import StatementShape from "./StatementShape.ts";
import { parsePath, targetMembers } from "./TargetSyntax.ts";

type Ctor<T> = new (...args: never[]) => T;

type SchemeMetadata = string[] | null;
type Slots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: LineMarker | null };
type TextSlots = { target: ParsedPath | null; metadata: SchemeMetadata; lineMarker: TextLineMarker | null };

export default class AstBuilder {
    readonly #advisories: PlurnkParseError[] = [];
    readonly #executorSpellings: ReadonlyMap<string, string>;

    constructor(executorSpellings: ReadonlyMap<string, string> = new Map()) {
        this.#executorSpellings = executorSpellings;
    }

    // {§parse-recovery}: advisories belong only to the statement that was built successfully.
    static build(
        ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext,
        executorSpellings: ReadonlyMap<string, string> = new Map(),
    ): { statements: PlurnkStatement[]; advisories: PlurnkParseError[] } {
        return new AstBuilder(executorSpellings).#buildStatement(ctx);
    }

    readonly #advise = (position: Position | undefined, message: string): void => {
        if (position === undefined) return;
        this.#advisories.push(new PlurnkParseError(position.line, position.column, "parser", message, "warning"));
    };

    readonly #parseRange = (text: string, position: Position): LineMarker =>
        parseRangeMarker(text, position, this.#advise);

    // {§op-shapes}: lower once at the language boundary, before dispatch or replay.
    static #annotation(body: string | null, position: Position): NoteStatement[] {
        return body === null || body.trim() === "" ? [] : [{
            op: "NOTE", aside: null, metadata: null, target: null, lineMarker: null, body, position,
        }];
    }

    // {§parse-recovery} — a heading with no target whose text opens with a word, `READ a.py <1,4>`: the word
    // stands where the target goes. FIND, READ and EDIT cannot run without one; the refusal says so.
    static #bareTarget(op: string, target: ParsedPath | null, inline: string | null, position: Position): void {
        if (target !== null || inline === null) return;
        const text = inline.trim();
        if (text === "" || SIGIL.test(text) || /^[<[`{\u00B7]/u.test(text)) return;
        const word = text.split(/\s/u, 1)[0];
        throw new PlurnkParseError(position.line, position.column, "visitor",
            `\`${op}\` has no target: \`${word}\` stands where the target goes.`, "error", StatementShape.workingForm(op, false));
    }

    // {§slot-order} — one JSON object where the option block goes, on an operation that takes
    // options and no bare matcher: read as `[{…}]`, so every consumer sees the taught shape. The receipt
    // names the indulgence once, in place of the {§slot-order} advisory. `placed` says the heading
    // admits a block there: BARE, WORK and FORK take one only after their target.
    #liftBareOptionObject(
        tag: string,
        metadata: SchemeMetadata,
        split: { inline: string | null; below: string | null },
        position: Position,
        placed = true,
    ): { metadata: SchemeMetadata; lifted: boolean } {
        if (!placed || metadata !== null || split.inline === null || !isJsonObject(split.inline.trim())) return { metadata, lifted: false };
        this.#advise(position, `\`${tag}\` took a bare option object; the taught form is \`[{…}]\`.`);
        return { metadata: [split.inline.trim()], lifted: true };
    }

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

    // {§parse-recovery} {§op-shapes} — an operation that takes no body does not use the
    // text its matcher did not read, on the heading line or beneath it; one advisory names where that text
    // stands, and the operation still runs: warn, never strike.
    #ignoreUnread(name: string, unread: { readonly inline: string | null; readonly below: string | null }, position: Position): void {
        const inline = unread.inline !== null && unread.inline.trim() !== "";
        const lines = unread.below === null || unread.below.trim() === "" ? 0 : unread.below.replace(/\r?\n$/u, "").split(/\r\n|\r|\n/u).length;
        if (!inline && lines === 0) return;
        const below = lines === 0 ? "" : lines === 1 ? `line ${position.line + 1}` : `lines ${position.line + 1}–${position.line + lines}`;
        const heading = inline ? `the text after its heading on line ${position.line}` : "";
        const where = [heading, below].filter((part) => part !== "").join(" and ");
        this.#advise(position, `${name} takes no body; ${where} ${inline && lines > 0 || lines > 1 ? "were" : "was"} not used.`);
    }

    // The matcher was offered the heading text, or the line beneath when the heading carries none.
    static #unread(consumed: boolean, inline: string | null, below: string | null): { inline: string | null; below: string | null } {
        if (!consumed) return { inline, below };
        return { inline: null, below: inline === null ? null : below };
    }

    // {§slot-order} — the body an operation takes, its heading-line text included. Each builder decides
    // what that text is; taking it as the body is named once, here, where the reading is made.
    #headingBody(name: string, ctx: ParserRuleContext, inline: string | null, position: Position): string | null {
        if (inline !== null) {
            this.#advise(position, `\`${name}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`);
        }
        return AstBuilder.#bodyTextOf(ctx);
    }

    #buildStatement(ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext): {
        statements: PlurnkStatement[];
        advisories: PlurnkParseError[];
    } {
        const built = this.#buildAny(ctx);
        const rawStatements = Array.isArray(built) ? built : [built];
        // {§operation-fences} — the name alone opened it; the receipt names the taught form, once.
        const opener = ctx.start?.text ?? "";
        if (opener.length > 0 && !opener.startsWith("`")) {
            this.#advise({ line: ctx.start!.line, column: ctx.start!.column }, `\`${opener}\` opened with no fence; the taught form is three backticks.`);
            return {
                statements: rawStatements.map((statement) => AstBuilder.#withoutNakedCloser(statement)),
                advisories: this.#advisories,
            };
        }
        return { statements: rawStatements, advisories: this.#advisories };
    }

    // {§operation-fences} — a naked block expects no closer, so a closer the author wrote anyway is still its last
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the statement with its body trimmed is the same op; the union's spread cannot say so
        return { ...statement, body } as PlurnkStatement;
    }

    #buildAny(ctx: StatementContext | MidStatementContext | DispositionStatementContext | SendStatementContext): PlurnkStatement | PlurnkStatement[] {
        // Disposition and SEND contexts can arrive without a statement wrapper.
        if (ctx instanceof DispositionStatementContext) return this.#buildDisposition(ctx);
        if (ctx instanceof SendStatementContext) return this.#buildSend(ctx);
        const send = ctx.sendStatement(); if (send) return this.#buildSend(send);
        const find = ctx.findStatement(); if (find) return this.#buildFind(find);
        const read = ctx.readStatement(); if (read) return this.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return this.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return this.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return this.#buildMove(move);
        const exec = ctx.execStatement(); if (exec) return this.#buildExec(exec);
        const bare = ctx.bareStatement(); if (bare) return this.#buildBare(bare);
        const work = ctx.workStatement(); if (work) return this.#buildWork(work);
        const fork = ctx.forkStatement(); if (fork) return this.#buildFork(fork);
        const kill = ctx.killStatement(); if (kill) return this.#buildKill(kill);
        const note = ctx.noteStatement(); if (note) return this.#buildNote(note);
        if ("dispositionStatement" in ctx) {
            const disposition = ctx.dispositionStatement(); if (disposition) return this.#buildDisposition(disposition);
        }
        throw new Error("statement context has no recognized alternative");
    }

    #buildFind(ctx: FindStatementContext): PlurnkStatement[] {
        const position = AstBuilder.#positionOf(ctx);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const statement = this.#buildFindFrom(ctx, AstBuilder.#asideOf(ctx), split.inline);
        const targets = statement.target === null ? [null] : targetMembers(statement.target);
        return [
            ...AstBuilder.#annotation(split.below, position),
            ...targets.map((target): FindStatement => ({ ...statement, target })),
        ];
    }

    #buildFindFrom(ctx: FindStatementContext, aside: string | null, inline: string | null): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractSlots(ctx.slotModifiers(), position, this.#parseRange);
        AstBuilder.#bareTarget("FIND", slots.target, inline, position);
        const lifted = liftMatcher("FIND", slots.metadata, position, inline, slots.lineMarker !== null, slots.target, this.#advise);
        this.#ignoreUnread("FIND", AstBuilder.#unread(lifted.consumed, inline, null), position);
        return {
            op: "FIND",
            aside: aside ?? lifted.aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : this.#parseRange(lifted.scope, position)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: null,
            position,
        };
    }

    #buildRead(ctx: ReadStatementContext): PlurnkStatement[] {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#targetSelections(ctx.targetGroup(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        AstBuilder.#bareTarget("READ", slots[0].target, split.inline, position);
        const lifted = this.#liftSelections("READ", slots, position, split.inline);
        this.#ignoreUnread("READ", AstBuilder.#unread(lifted.consumed, split.inline, null), position);
        const aside = AstBuilder.#asideOf(ctx) ?? lifted.aside;
        // {§op-shapes} — a READ is never rewritten: a glob target is the runtime's
        // fan-out over every matching path, with or without a matcher (core {§read}).
        return [...AstBuilder.#annotation(split.below, position), ...lifted.selections.flatMap(AstBuilder.#selectionTargets).map((selection): ReadStatement => ({
            op: "READ",
            aside,
            ...selection,
            body: null,
            position,
        }))];
    }

    #targetSelections(ctx: TargetGroupContext | null, position: Position): TextSlots[] {
        const first = ctx?.firstResourceSelection() ?? null;
        return first === null
            ? [this.#extractTextSlots(ctx, position)]
            : [first, ...ctx!.resourceSelection()].map((selection) => this.#extractTextSlots(selection, position));
    }

    static #selectionTargets(selection: TextSlots & { matcher: MatcherBody | null }): (TextSlots & { matcher: MatcherBody | null })[] {
        return selection.target === null ? [selection]
            : targetMembers(selection.target).map((target) => ({ ...selection, target }));
    }

    // {§slot-order} {§parse-recovery}: recover only when ownership is unique, before admitting any member.
    #liftSelections(op: string, slots: TextSlots[], position: Position, raw: string | null): {
        selections: (TextSlots & { matcher: MatcherBody | null })[];
        aside: string | null;
        consumed: boolean;
    } {
        const sole = slots.length === 1 ? slots[0] : null;
        if (sole !== null) {
            const lifted = liftMatcher(op, sole.metadata, position, raw, sole.lineMarker !== null, sole.target, this.#advise);
            return {
                selections: [{ ...sole, metadata: lifted.metadata, matcher: lifted.matcher,
                    lineMarker: sole.lineMarker ?? (lifted.scope === null ? null : parseTextLineMarker(lifted.scope, position, this.#advise)) }],
                aside: lifted.aside, consumed: lifted.consumed,
            };
        }
        const bare = bareMatcher(raw, op, position, { scope: false, metadata: false }, this.#advise);
        if (bare?.scope != null || bare?.metadata != null) {
            throw new PlurnkParseError(position.line, position.column, "visitor",
                `${bare.scope != null ? `The scope \`${bare.scope}\`` : `The option block \`[${bare.metadata}]\``} follows the shared pattern of a target group.`, "error",
                "In a target group each `(path)` carries its own scope and option block, and the one shared pattern comes last.");
        }
        const selections = slots.map((selection, index) => {
            const lifted = liftBareMatcher(bare, selection.metadata, position, selection.target, index === 0 ? this.#advise : undefined);
            return { ...selection, metadata: lifted.metadata, matcher: lifted.matcher };
        });
        return { selections, aside: bare?.aside ?? null, consumed: bare !== null };
    }

    #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractTextSlots(ctx.slotModifiers(), position);
        // {§parse-recovery} — a sigil on the heading line is the matcher; the lines beneath are the
        // replacement (none deletes each match). Any other heading-line text is the first line of the body.
        const split = AstBuilder.#splitInlineBody(ctx, position);
        AstBuilder.#bareTarget("EDIT", slots.target, split.inline, position);
        const lifted = liftMatcher("EDIT", slots.metadata, position, split.inline, slots.lineMarker !== null, slots.target, this.#advise);
        return {
            op: "EDIT",
            aside: AstBuilder.#asideOf(ctx) ?? lifted.aside,
            ...slots,
            lineMarker: slots.lineMarker ?? (lifted.scope === null ? null : parseTextLineMarker(lifted.scope, position, this.#advise)),
            metadata: lifted.metadata,
            matcher: lifted.matcher,
            body: lifted.consumed ? split.below : this.#headingBody("EDIT", ctx, split.inline, position),
            position,
        };
    }

    #buildCopy(ctx: CopyStatementContext): CopyStatement {
        const position = AstBuilder.#positionOf(ctx);
        const modifier = ctx.transferModifiers();
        this.#ignoreUnread("COPY", AstBuilder.#splitInlineBody(ctx, position), position);
        return {
            op: "COPY",
            aside: AstBuilder.#asideOf(ctx),
            source: this.#resourceSelectionFromCtx(modifier.firstResourceSelection(), position),
            destination: this.#resourceSelectionFromCtx(modifier.resourceSelection(), position),
            position,
        };
    }

    #buildMove(ctx: MoveStatementContext): MoveStatement {
        const position = AstBuilder.#positionOf(ctx);
        const modifier = ctx.transferModifiers();
        this.#ignoreUnread("MOVE", AstBuilder.#splitInlineBody(ctx, position), position);
        return {
            op: "MOVE",
            aside: AstBuilder.#asideOf(ctx),
            source: this.#resourceSelectionFromCtx(modifier.firstResourceSelection(), position),
            destination: this.#resourceSelectionFromCtx(modifier.resourceSelection(), position),
            position,
        };
    }

    #buildDisposition(ctx: DispositionStatementContext): DispositionStatement {
        const position = AstBuilder.#positionOf(ctx);
        const op = (ctx.start?.text ?? "").replace(/^`+[0-9]*/, "");
        if (!TurnDisposition.isOp(op)) throw new Error(`Unknown disposition operation: ${op}`);
        const target = this.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), position);
        const durations = [...AstBuilder.#findAll(ctx, MetadataContext), ...AstBuilder.#findAll(ctx, LineMarkerContext)]
            .flatMap((marker) => {
                const raw = marker.getText();
                const seconds = /^\[\s*-?[0-9]+(?:\.[0-9]+)?\s*\]$/u.test(raw) ? Number(raw.slice(1, -1)) : Number.NaN;
                if (Number.isFinite(seconds) && seconds >= 0) return [seconds];
                this.#advise(AstBuilder.#positionOf(marker), `Ignored WAIT duration ${raw}.`);
                return [];
            });
        return {
            op,
            aside: AstBuilder.#asideOf(ctx),
            target,
            metadata: null,
            // {§op-shapes} Repeated duration bounds compose as their earliest wake.
            lineMarker: null,
            seconds: durations.length === 0 ? null : Math.min(...durations),
            body: this.#headingBody(op, ctx, AstBuilder.#splitInlineBody(ctx, position).inline, position),
            position,
        };
    }

    #buildNote(ctx: NoteStatementContext): NoteStatement {
        const position = AstBuilder.#positionOf(ctx);
        return {
            op: "NOTE", aside: AstBuilder.#asideOf(ctx), target: null, metadata: null, lineMarker: null,
            body: this.#headingBody("NOTE", ctx, AstBuilder.#splitInlineBody(ctx, position).inline, position), position,
        };
    }

    // A mid-turn SEND is a message to its recipient path, or to the user when it names none.
    #buildSend(ctx: SendStatementContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractSlots(ctx.firstResourceSelection(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = this.#liftBareOptionObject("SEND", AstBuilder.#metadataFromCtx(ctx), split, position);
        const raw = options.lifted ? split.below : this.#headingBody("SEND", ctx, split.inline, position);
        return {
            op: "SEND",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const runtime = this.#executorOf(ctx);
        const slots = this.#extractExecSlots(ctx.execModifiers(), position, runtime);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        return {
            runtime,
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            body: this.#headingBody(runtime, ctx, split.inline, position),
            position,
        };
    }

    // {§fence-pairing} — known spellings are canonicalized; unknown tags use lowercase.
    #executorOf(ctx: ExecStatementContext): RuntimeTag {
        const name = ctx.OPEN_EXEC().getText().replace(/^`+[0-9]*/, "").toLowerCase();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- OPEN_EXEC admits a runtime tag's spelling; lowercased it is the tag
        return (this.#executorSpellings.get(name) ?? name) as RuntimeTag;
    }

    #buildBare(ctx: BareStatementContext): BareStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = this.#liftBareOptionObject("BARE", slots.metadata, split, position, slots.target !== null);
        return {
            op: "BARE",
            aside: AstBuilder.#asideOf(ctx),
            target: slots.target,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : this.#headingBody("BARE", ctx, split.inline, position) ?? "",
            position,
        };
    }

    #buildKill(ctx: KillStatementContext): KillStatement[] {
        const position = AstBuilder.#positionOf(ctx);
        // {§op-shapes} — the scope names lines of a log body or of an entry; null kills the whole target.
        const slots = this.#targetSelections(ctx.targetGroup(), position);
        const first = slots[0];
        if (first.target === null) throw new PlurnkParseError(position.line, position.column, "parser", "KILL requires a target.");
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const shape = StatementShape.body("KILL", first);
        // {§log-kill-scope} — beneath a log KILL the body is the model's distillation of what it retires,
        // never a matcher; an inline pattern on the heading line still lifts. Every other target takes no body.
        const distilling = shape === "distillation";
        const lifted = this.#liftSelections("KILL", slots, position, split.inline);
        if (!distilling) this.#ignoreUnread("This KILL", AstBuilder.#unread(lifted.consumed, split.inline, split.below), position);
        const distillation = !distilling ? null
            : lifted.consumed || split.inline === null ? split.below : this.#headingBody("KILL", ctx, split.inline, position);
        return lifted.selections.flatMap(AstBuilder.#selectionTargets).map((selection, index) => ({
            op: "KILL",
            aside: AstBuilder.#asideOf(ctx) ?? lifted.aside,
            ...selection,
            body: index === 0 && distillation !== null && distillation.trim() !== "" ? distillation : null,
            position,
        }));
    }

    #buildWork(ctx: WorkStatementContext): WorkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = this.#liftBareOptionObject("WORK", slots.metadata, split, position, slots.target !== null);
        return {
            op: "WORK",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : this.#headingBody("WORK", ctx, split.inline, position) ?? "",
            position,
        };
    }

    #buildFork(ctx: ForkStatementContext): ForkStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = this.#extractBranchSlots(ctx.targetWithMetadata(), position);
        const split = AstBuilder.#splitInlineBody(ctx, position);
        const options = this.#liftBareOptionObject("FORK", slots.metadata, split, position, slots.target !== null);
        return {
            op: "FORK",
            aside: AstBuilder.#asideOf(ctx),
            ...slots,
            metadata: options.metadata,
            lineMarker: null,
            body: options.lifted ? split.below ?? "" : this.#headingBody("FORK", ctx, split.inline, position) ?? "",
            position,
        };
    }

    #extractBranchSlots(ctx: TargetWithMetadataContext | null, pos: Position): { target: ParsedPath | null; metadata: SchemeMetadata } {
        return {
            target: this.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(ctx),
        };
    }

    static #singleMarker(ctx: ParserRuleContext | null, pos: Position): LineMarkerContext | null {
        const found = AstBuilder.#findAll(ctx, LineMarkerContext);
        if (found.length > 1) {
            const written = found.map((marker) => `\`${marker.getText()}\``);
            throw new PlurnkParseError(pos.line, pos.column, "visitor",
                `A resource selection takes one scope, and ${written.join(" and ")} both stand here.`, "error",
                "One scope per selection, such as `<12,40>` or `<@abcde,+5>`.");
        }
        return found[0] ?? null;
    }

    #extractSlots(
        modCtx: SlotModifiersContext | FirstResourceSelectionContext | ResourceSelectionContext | null,
        pos: Position,
        parseScope: (text: string, position: Position) => LineMarker = (text) => parseLineMarker(text),
    ): Slots {
        const marker = AstBuilder.#singleMarker(modCtx, pos);
        return {
            target: this.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: marker === null ? null : parseScope(marker.getText(), AstBuilder.#positionOf(marker)),
        };
    }

    #extractTextSlots(modCtx: SlotModifiersContext | FirstResourceSelectionContext | ResourceSelectionContext | TargetGroupContext | null, pos: Position): TextSlots {
        return {
            target: this.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            metadata: AstBuilder.#metadataFromCtx(modCtx),
            lineMarker: this.#textLineMarkerFromCtx(AstBuilder.#singleMarker(modCtx, pos)),
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

    #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position, executor: string): Slots {
        // {§op-shapes} — every slot at most once; the grammar admits any order.
        const once = <T extends ParserRuleContext>(type: Ctor<T>, slot: string): T | null => {
            const found = AstBuilder.#findAll(modCtx, type);
            if (found.length > 1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `${executor} accepts ${slot} at most once`, "error",
                    StatementShape.workingForm(executor, true));
            }
            return found[0] ?? null;
        };
        return {
            target: this.#targetFromCtx(once(TargetContext, "one `(program)` path"), pos),
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

    #targetFromCtx(ctx: TargetContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const nestedScope = ctx.lineMarker();
        if (nestedScope !== null) {
            this.#advise(AstBuilder.#positionOf(nestedScope), "The scope was inside the target slot; it was applied as the operation scope.");
        }
        // {§parse-recovery} — `→ path` names the target as the log's heading shows it.
        const arrow = ctx.ARROW_TARGET();
        const text = arrow !== null ? arrow.getText().replace(/^\u2192[ \t]*/u, "") : ctx.TARGET_TEXT().map((token) => token.getText()).join("");
        return parsePath(text, pos);
    }

    static #metadataFromCtx(ctx: ParserRuleContext | null): SchemeMetadata {
        const blocks = AstBuilder.#findAll(ctx, MetadataContext);
        return blocks.length === 0
            ? null
            : blocks.map((block) => block.METADATA_TEXT().map((token) => token.getText()).join(""));
    }

    #resourceSelectionFromCtx(ctx: FirstResourceSelectionContext | ResourceSelectionContext, pos: Position): ResourceSelection {
        const target = this.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos);
        if (target === null) throw new Error("resource selection grammar did not produce a target");
        return {
            target,
            metadata: AstBuilder.#metadataFromCtx(ctx),
            lineMarker: this.#textLineMarkerFromCtx(AstBuilder.#singleMarker(ctx, pos)),
            matcher: null,
        };
    }

    static #lineMarkerFromCtx(ctx: LineMarkerContext | null): LineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return parseLineMarker(text);
    }

    #textLineMarkerFromCtx(ctx: LineMarkerContext | null): TextLineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return parseTextLineMarker(text, AstBuilder.#positionOf(ctx), this.#advise);
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #asideOf(ctx: ParserRuleContext): string | null {
        const token = AstBuilder.#findToken(ctx, plurnkParser.ASIDE);
        if (token === null) return null;
        // {§parse-recovery} — ` · words` after the slots is the aside.
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
        const closer = AstBuilder.#findToken(ctx, plurnkParser.SECTION_END);
        if (closer !== null && closer.includes("`")) return text;
        const whole = text.replace(/\r?\n$/u, "");
        return whole === "" ? null : whole;
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}
