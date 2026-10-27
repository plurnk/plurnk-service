lexer grammar plurnkLexer;

tokens {
    OPEN_FIND, OPEN_READ, OPEN_EDIT, OPEN_COPY, OPEN_MOVE,
    OPEN_SEND, OPEN_NOTE, OPEN_WAIT,
    OPEN_EXEC, OPEN_BARE, OPEN_WORK, OPEN_FORK, OPEN_KILL,
    LPAREN, RPAREN, LBRACKET, RBRACKET, L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ASIDE, ARROW_TARGET
}

@lexer::header {
import FencePairing, { type BlockEnd, type Pairing } from "../FencePairing.ts";
import HeadingReader, { HeadingErrors } from "../HeadingReader.ts";
import StatementShape from "../StatementShape.ts";
}

@lexer::members {
// {§fence-pairing} — block boundaries are decided once, for the whole input, by FencePairing; the
// predicates below only ask it where the block they are in ends.
private pairingCache: Pairing | null = null;
// HeadingReader uses this mode to read slots without recursively pairing the input.
public lineOnly: boolean = false;
private fencePairing(): Pairing {
    this.pairingCache ??= FencePairing.pair(this.inputStream.toString(), {
        operations: new Set(Object.keys(plurnkLexer.OPERATIONS)),
        executors: this.knownExecutors,
        reasoning: this.reasoning,
        heading: (heading, name) => {
            const { selfClosed, statement } = plurnkLexer.readHeading(heading, this.knownExecutors, this.reasoning);
            const op = statement?.op ?? name;
            const body = StatementShape.body(op, statement?.op === "KILL" ? statement : undefined);
            return { selfClosed, bodiless: body === "none", prose: body === "prose", mutation: body === "mutation" };
        },
        wellFormed: this.wellFormed,
    });
    return this.pairingCache;
}
// The heading lexer decides whether a heading line closes its block on that line: targets, metadata
// strings and asides may hold backticks that close nothing ({§fence-pairing}, {§fence-pairing}).
private closedOnLine(tokens: readonly Token[]): boolean {
    return this.mode === plurnkLexer.DEFAULT_MODE && (this.inlineCloserSeen
        || tokens.some((token) => token.type === plurnkLexer.SECTION_END && token.text?.includes("\x60")));
}
public static readHeading(heading: string, executors?: ReadonlySet<string>, reasoning = false) {
    const lexer = new plurnkLexer(antlr.CharStream.fromString(heading + "\n"));
    lexer.lineOnly = true;
    if (executors !== undefined) lexer.knownExecutors = new Set(executors);
    lexer.reasoning = reasoning;
    const errors = new HeadingErrors();
    lexer.removeErrorListeners();
    lexer.addErrorListener(errors);
    const tokens = lexer.getAllTokens();
    return { selfClosed: lexer.closedOnLine(tokens), statement: HeadingReader.read(tokens, errors) };
}
private lineStartOf(index: number): number {
    const starts = this.fencePairing().lineStarts;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= index) lo = mid; else hi = mid - 1; }
    return starts[lo]!;
}
// Where the open block ends. A body without an entry is a classifier disagreement: fail hard.
private blockEnd(required: boolean): BlockEnd | undefined {
    if (this.lineOnly) return undefined;
    const end = this.fencePairing().ends.get(this.lineStartOf(this.openFenceStart));
    if (end === undefined && required) throw new Error(`fence pairing has no end for the block opened at ${this.openFenceStart}`);
    return end;
}
// {§op-shapes}: only authored closures, never repaired/incomplete blocks.
public hasClosedBlock(line: number): boolean {
    const pairing = this.fencePairing();
    const start = pairing.lineStarts[line - 1];
    return start !== undefined && (pairing.selfClosed.has(start) || pairing.ends.get(start)?.kind === "closer");
}
private quotationHere(): boolean { return this.lineOnly ? this.fenceOpens() : this.fencePairing().quotations.has(this.lineStartOf(this.inputStream.index)); }
private splitHere(): boolean { return !this.lineOnly && this.fencePairing().splits.has(this.lineStartOf(this.inputStream.index)); }
private surplusHere(): boolean { return !this.lineOnly && this.fencePairing().surplus.has(this.lineStartOf(this.inputStream.index)); }
private openOp: string = "";
// {§executor-runtime-declaration} — the opener names a runtime rather than an operation keyword.
private execFence: boolean = false;
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private fenceLength: number = 0;
private fenceCharacter: number = 0x60;
private openFenceStart: number = 0;
// {§op-shapes} — quotations are opaque; no program-boundary recovery.
public reasoning: boolean = false;
private started: boolean = false;
// {§fence-pairing} — a closer on the heading line may be followed by the next opener on the same line.
private inlineChain: boolean = false;
// {§fence-pairing} — a closer already consumed mid-heading, so the line's end closes.
private inlineCloserSeen: boolean = false;
private unclosedAsides: Array<{ line: number; column: number }> = [];

// After a closer's text, does an operation heading follow on the same line?
private openerFollows(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    let ticks = 0;
    while (this.inputStream.LA(cursor) === 0x60) { ticks++; cursor++; }
    if (ticks < 3) return false;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; cursor++;
    }
    return name !== "" && this.headingName(name, cursor);
}

private noteUnclosedAside(): void {
    this.unclosedAsides.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn });
}

public takeUnclosedAsides(): Array<{ line: number; column: number }> {
    const taken = this.unclosedAsides;
    this.unclosedAsides = [];
    return taken;
}

private asideClosesOnLine(): boolean {
    let cursor = 1;
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x0A || c === 0x0D) return false;
        if (c === 0x2D && this.inputStream.LA(cursor + 1) === 0x2D && this.inputStream.LA(cursor + 2) === 0x3E) return true;
        cursor++;
    }
}
// {§parse-recovery} - the log's receipt heading copied as syntax: the arrow target, the token charge, a
// middle-dot note, and an EDIT's anchor written without its angle brackets. Each is read, and noted once.
private headingNotations: Array<{ line: number; column: number; kind: string; text: string }> = [];
private noteNotation(kind: string): void {
    this.headingNotations.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn, kind, text: this.text });
}
public takeHeadingNotations(): Array<{ line: number; column: number; kind: string; text: string }> {
    const taken = this.headingNotations;
    this.headingNotations = [];
    return taken;
}
// {§parse-recovery} - a comment later on the line, before its end or a fence: the comment is the aside,
// and a middle-dot note before it is stray text.
private asideCommentLater(): boolean {
    let cursor = 1;
    for (let c = this.inputStream.LA(cursor); c > 0 && c !== 0x0A && c !== 0x0D && c !== 0x60; c = this.inputStream.LA(++cursor)) {
        if (c === 0x3C && this.inputStream.LA(cursor + 1) === 0x21 && this.inputStream.LA(cursor + 2) === 0x2D && this.inputStream.LA(cursor + 3) === 0x2D) return true;
    }
    return false;
}
// The offset past horizontal whitespace, digits and a following "tokens" word after the middle dot at LA(1).
private afterCharge(): { offset: number; digits: boolean } {
    let cursor = this.skipHorizontal(2);
    const start = cursor;
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) cursor++;
    const digits = cursor > start;
    if (digits) {
        const word = this.skipHorizontal(cursor);
        if (word > cursor && [0x74, 0x6F, 0x6B, 0x65, 0x6E, 0x73].every((code, index) => this.inputStream.LA(word + index) === code)) cursor = word + 6;
    }
    return { offset: this.skipHorizontal(cursor), digits };
}
// The charge ends the heading, or stands before a slot, a closer, or (with no number) a matcher sigil.
private chargeAhead(): boolean {
    const { offset, digits } = this.afterCharge();
    const c = this.inputStream.LA(offset);
    if (c <= 0 || c === 0x0A || c === 0x0D || c === 0x3C || c === 0x5B || c === 0x60) return true;
    return !digits && [0x2F, 0x24, 0x7E, 0x26, 0x5E].includes(c);
}
// An anchor alone where the scope goes: nothing but an aside, a closer or the line end follows it.
private bareAnchorAhead(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) > 0 && this.inputStream.LA(cursor) !== 0x20 && this.inputStream.LA(cursor) !== 0x09 && this.inputStream.LA(cursor) !== 0x0A && this.inputStream.LA(cursor) !== 0x0D && this.inputStream.LA(cursor) !== 0x60) cursor++;
    cursor = this.skipHorizontal(cursor);
    const c = this.inputStream.LA(cursor);
    if (c <= 0 || c === 0x0A || c === 0x0D || c === 0x60) return true;
    return c === 0x3C && this.inputStream.LA(cursor + 1) === 0x21 && this.inputStream.LA(cursor + 2) === 0x2D && this.inputStream.LA(cursor + 3) === 0x2D;
}
// {§operation-fences} - tags that end an open block from inside it; the host adds executors.
public knownExecutors: Set<string> = new Set(["sh"]);
public wellFormed: ((runtime: string, body: string) => boolean) | undefined = undefined;
// {§fence-pairing}: one recognition rule for OPEN, inline chains, recovery and fence pairing.
private headingName(name: string, offset: number): boolean {
    const at = this.skipHorizontal(offset);
    let suffix = "";
    for (let index = at; index < at + 4 && this.inputStream.LA(index) > 0; index++) suffix += String.fromCodePoint(this.inputStream.LA(index));
    return HeadingReader.opens(name, suffix, this.knownExecutors, this.reasoning);
}
private slotReady: boolean = false;
// {§slot-order}: whether this heading has taken its target; a SEND without one takes no scope.
private headingTarget: boolean = false;
private targetClosed(): void {
    this.slotReady = true;
    this.headingTarget = true;
}
private scopeless(): boolean {
    return this.openOp === "WORK" || this.openOp === "FORK" || this.openOp === "BARE" || this.openOp === "NOTE"
        || this.openOp === "SEND" && !this.headingTarget;
}
private targetDepth: number = 0;
private metadataDepth: number = 0;
private inlineBody: boolean = false;
private quotedTags: Array<{ line: number; column: number; tag: string }> = [];
private forgottenTags: Array<{ line: number; column: number; tag: string }> = [];
private quotedSpans: Array<{ start: number; end: number }> = [];
private quoteLabeled = false;
private quoteStart: number = -1;

// {§fence-pairing} - explicit slots do not require a registered runtime.
private operationHeading(): boolean {
    const name = this.text.replace(/^\x60+/, "");
    return this.headingName(name, 1);
}

// {§fence-pairing} - a fence that opened no operation quotes. Its tag draws nothing: an unknown name
// without invocation slots is a code block at any width, and one indented further than three spaces is the taught
// offset ({§fence-pairing}). Reasoning quotes freely.
private quote(): void {
    this.quoteStart = this.tokenStartCharIndex;
    // A labeled code block (a plurnk or md tag) is an example by declaration; only an unlabeled
    // wrapper around an operation is the mis-fence that earns a receipt ({§fence-pairing}).
    // No literal backtick in this block: the action scanner reads one as a string delimiter.
    this.quoteLabeled = /[A-Za-z]/.test(this.text.replace(/^[\x60~]+/, ""));
    this.open();
}

// {§fence-pairing} - at the top level, a bare fence and the operation heading on the line under it are one
// opener: the line break is dropped from the token, so the operation opens exactly as if written on one line.
private splitOpen(): void {
    this.forgottenTags.push({ line: (this as any).currentTokenStartLine, column: 0, tag: this.text.replace(/^\x60+[ \t]*\r?\n/, "") });
    this.text = this.text.replace(/[ \t]*\r?\n/, "");
    this.open();
}

public takeForgottenTags(): Array<{ line: number; column: number; tag: string }> {
    const taken = this.forgottenTags;
    this.forgottenTags = [];
    return taken;
}

// {§fence-pairing} - an operation inside an unlabeled code block is shown, never run: the model that
// wrapped it is told so once. Labeled blocks draw nothing here.
private noteQuoted(): void {
    if (this.reasoning || this.quoteLabeled) return;
    const tag = this.text.replace(/^\x60+/, "");
    if (!this.headingName(tag, 1)) return;
    this.quotedTags.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn, tag });
}

private endQuote(): void {
    if (this.quoteStart >= 0) this.quotedSpans.push({ start: this.quoteStart, end: this.inputStream.index });
    this.quoteStart = -1;
}

// The quoted character spans, the last one running to the end of the input when unclosed.
public takeQuotedSpans(length: number): Array<{ start: number; end: number }> {
    if (this.quoteStart >= 0) this.quotedSpans.push({ start: this.quoteStart, end: length });
    this.quoteStart = -1;
    const taken = this.quotedSpans;
    this.quotedSpans = [];
    return taken;
}

public takeQuotedTags(): Array<{ line: number; column: number; tag: string }> {
    const taken = this.quotedTags;
    this.quotedTags = [];
    return taken;
}

private static readonly OPERATIONS: Readonly<Record<string, number>> = {
    FIND: plurnkLexer.OPEN_FIND, READ: plurnkLexer.OPEN_READ,
    EDIT: plurnkLexer.OPEN_EDIT, COPY: plurnkLexer.OPEN_COPY, MOVE: plurnkLexer.OPEN_MOVE,
    SEND: plurnkLexer.OPEN_SEND, BARE: plurnkLexer.OPEN_BARE,
    NOTE: plurnkLexer.OPEN_NOTE, WAIT: plurnkLexer.OPEN_WAIT,
    WORK: plurnkLexer.OPEN_WORK, FORK: plurnkLexer.OPEN_FORK, KILL: plurnkLexer.OPEN_KILL,
};

// {§operation-fences} — a native name and optional complete aside, outside reasoning.
private nakedHeadingHere(): boolean {
    if (!this.atColumnZero() || this.reasoning) return false;
    let name = "";
    for (let cursor = 1; ; cursor++) {
        const c = this.inputStream.LA(cursor);
        if (c >= 0x41 && c <= 0x5A) { name += String.fromCharCode(c); continue; }
        const after = this.skipHorizontal(cursor);
        const end = this.inputStream.LA(after);
        return Object.hasOwn(plurnkLexer.OPERATIONS, name) && (end <= 0 || end === 0x0A || end === 0x0D || this.asideToLineEnd(after));
    }
}

// The naked block opens as if fenced with the taught three backticks.
private openNaked(): void {
    this.open(this.text);
    this.fenceLength = 3;
    this.fenceCharacter = 0x60;
    this.naked = true;
}

// {§operation-fences} - the name alone again, on its own line outside any nested block, closes the
// naked block it opened.
private nakedCloserAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    if (after === null) return false;
    const ends = this.blockEnd(false);
    if (ends?.kind !== "closer" || this.lineStartOf(this.inputStream.index + after - 1) !== ends.offset) return false;
    for (let index = 0; index < this.openOp.length; index++) {
        if (this.inputStream.LA(after + index) !== this.openOp.charCodeAt(index)) return false;
    }
    const end = this.inputStream.LA(this.skipHorizontal(after + this.openOp.length));
    return end <= 0 || end === 0x0A || end === 0x0D;
}

private naked: boolean = false;

private open(implicitName?: string): void {
    this.naked = false;
    this.fenceLength = 0;
    this.fenceCharacter = this.text.charCodeAt(0);
    while (this.text.charCodeAt(this.fenceLength) === this.fenceCharacter) this.fenceLength++;
    const name = implicitName ?? this.text.slice(this.fenceLength);
    const native = Object.hasOwn(plurnkLexer.OPERATIONS, name) ? plurnkLexer.OPERATIONS[name] : undefined;
    this.openOp = name;
    this.execFence = native === undefined;
    this.type = native ?? plurnkLexer.OPEN_EXEC;
    this.inlineChain = false;
    this.inlineCloserSeen = false;
    this.openHeading = this.text;
    this.openFenceStart = this.tokenStartCharIndex;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.started = true;
    this.slotReady = true;
    this.headingTarget = false;
    this.inlineBody = false;
}

// {§fence-pairing} CommonMark: a backtick fence's info string cannot contain a backtick, so a line
// like ```KILL (x)``` is inline code, not an opener, and quotes nothing after it.
private fenceOpens(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) !== 0x60) return true;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    for (let c = this.inputStream.LA(cursor); c > 0 && c !== 0x0A && c !== 0x0D; c = this.inputStream.LA(++cursor)) {
        if (c === 0x60) return false;
    }
    return true;
}

// The orphaned closer is a whole line: nothing but the fence follows it.
private orphanAtLineEnd(): boolean {
    const c = this.inputStream.LA(1);
    return c <= 0 || c === 0x0A || c === 0x0D;
}

// {§operation-fences} - the name follows a newline directly, or begins the input.
private atColumnZero(): boolean {
    const c = this.inputStream.LA(-1);
    return c <= 0 || c === 0x0A || c === 0x0D;
}

// {§fence-pairing} - a fence line may follow at most three spaces (CommonMark); four or more,
// or a tab, make it indented code: neither an opener, a closer nor a heading.
private atLineStart(): boolean {
    let spaces = 0;
    for (let back = 1; ; back++) {
        const c = this.inputStream.LA(-back);
        if (c <= 0 || c === 0x0A || c === 0x0D) return spaces <= 3;
        if (c !== 0x20) return false;
        spaces++;
    }
}

// {§fence-pairing} - the offset of the fence run at or after this offset when its line indents it
// by at most three spaces; null when four or more, or a tab, make the line indented code. Off the
// line start (a closer on the heading line) indentation is not in question.
private fenceIndent(offset: number): number | null {
    let spaces = 0;
    let tab = false;
    for (let index = offset - 1; ; index--) {
        const c = this.inputStream.LA(index >= 1 ? index : index - 1);
        if (c <= 0 || c === 0x0A || c === 0x0D) break;
        if (c !== 0x20 && c !== 0x09) return this.skipHorizontal(offset);
        if (c === 0x09) tab = true; else spaces++;
    }
    for (;; offset++) {
        const c = this.inputStream.LA(offset);
        if (c !== 0x20 && c !== 0x09) return tab || spaces > 3 ? null : offset;
        if (c === 0x09) tab = true; else spaces++;
    }
}

private skipHorizontal(offset: number): number {
    while (this.inputStream.LA(offset) === 0x20 || this.inputStream.LA(offset) === 0x09) offset++;
    return offset;
}

private offsetAfterEol(offset: number): number | null {
    if (this.inputStream.LA(offset) === 0x0D && this.inputStream.LA(offset + 1) === 0x0A) return offset + 2;
    return this.inputStream.LA(offset) === 0x0A ? offset + 1 : null;
}

// {§operation-fences} - a closer is a line of at least the opener's backticks and nothing else, within
// three spaces of the line start ({§fence-pairing}); {§operation-fences} claims nested closers first.
private closingAt(offset: number): boolean {
    if (this.naked || this.inputStream.LA(offset === 1 ? -1 : offset - 1) === this.fenceCharacter) return false;
    const fence = this.fenceIndent(offset);
    if (fence === null) return false;
    offset = fence;
    if ((this.mode === plurnkLexer.BODY || this.mode === plurnkLexer.QUOTATION) && !(this.inlineBody && offset === 1)) {
        // {§fence-pairing} decides every block end in a body or quotation, whatever the closer's width; only a
        // heading that closes on its own line keeps the local rule below.
        if (!this.lineOnly) {
            const end = this.blockEnd(false);
            if (end !== undefined) return end.kind === "closer" && this.lineStartOf(this.inputStream.index + offset - 1) === end.offset;
            if (!this.fencePairing().selfClosed.has(this.lineStartOf(this.openFenceStart))) throw new Error(`fence pairing has no end for the block opened at ${this.openFenceStart}`);
        }
    }
    let cursor = offset;
    while (this.inputStream.LA(cursor) === this.fenceCharacter) cursor++;
    if (cursor - offset < this.fenceLength) return false;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null) return true;
    if (this.reasoning) return false;
    // {§fence-pairing} — a closer followed on its line by one aside and nothing else still closes;
    // read as body, that line would be written into the edited resource (#758, dogfood item 17).
    if (this.asideToLineEnd(cursor)) return true;
    // {§fence-pairing} — a closer followed on its line by the next opener still closes.
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let at = cursor + ticks;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(at);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; at++;
    }
    return name !== "" && this.headingName(name, at);
}

// {§operation-fences} — an operation heading of the taught width recovers an unclosed block only
// after {§operation-fences} has ruled out complete nesting: a wider block holds narrower headings
// only while it closes, so no unclosed block swallows the operations after it.
private headingAt(offset: number): boolean {
    if (this.reasoning) return false;
    let cursor = offset;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    if (cursor - offset < 3) return false;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch;
        cursor++;
    }
    return name !== "" && this.headingName(name, cursor);
}

private headingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    const at = after === null ? null : this.fenceIndent(after);
    if (at === null || this.lineOnly) return false;
    const end = this.blockEnd(false);
    return end?.kind === "before" && this.lineStartOf(this.inputStream.index + after! - 1) === end.offset && this.headingAt(at);
}

// `<!-- … -->` at this offset, then only horizontal whitespace to the end of the line or input.
private asideToLineEnd(at: number): boolean {
    const open = [0x3C, 0x21, 0x2D, 0x2D];
    if (!open.every((code, index) => this.inputStream.LA(at + index) === code)) return false;
    let cursor = at + open.length;
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x0A || c === 0x0D) return false;
        if (c === 0x2D && this.inputStream.LA(cursor + 1) === 0x2D && this.inputStream.LA(cursor + 2) === 0x3E) break;
        cursor++;
    }
    cursor += 3;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    return this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null;
}

private closingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.closingAt(after);
}

// {§fence-pairing} — true when the run here closes the open block but more of the
// heading follows on the line and it is not the next opener. Slots, matchers, asides and option
// blocks all still belong to this heading, so the closer is skipped and reading continues.
private closerWithHeadingAhead(): boolean {
    if (this.inputStream.LA(-1) === 0x60) return false;
    let cursor = 1;
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < this.fenceLength) return false;
    let at = cursor + ticks;
    while (this.inputStream.LA(at) === 0x20 || this.inputStream.LA(at) === 0x09) at++;
    // End of line or input: the ordinary closer owns it.
    if (this.inputStream.LA(at) <= 0 || this.offsetAfterEol(at) !== null) return false;
    // The next opener on the line: {§fence-pairing} owns it.
    return !this.openerFollowsAt(at);
}

// Does an operation heading begin at this offset?
private openerFollowsAt(at: number): boolean {
    let ticks = 0;
    while (this.inputStream.LA(at + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let cursor = at + ticks;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x28 || c === 0x3c || c === 0x5b || c === 0x60) break;
        name += String.fromCharCode(c);
        cursor++;
    }
    return name !== "" && this.headingName(name, cursor);
}

private targetScopeEnd(): boolean {
    let offset = 1;
    while (this.inputStream.LA(offset) === 0x20 || this.inputStream.LA(offset) === 0x09) offset++;
    return this.targetDepth === 0 && this.inputStream.LA(offset) === 0x29;
}

private inlineBodyAhead(): boolean {
    const previous = this.inputStream.LA(-1);
    return previous === 0x20 || previous === 0x09;
}

public getOpenTag(): string { return this.openOp; }
public getOpenOp(): string { return this.openOp; }
public isExecFence(): boolean { return this.execFence; }
public getOpenTagLine(): number { return this.openHeadingLine; }
public getOpenTagColumn(): number { return this.openHeadingColumn; }
public getOpenHeading(): string { return this.openHeading; }
public getFenceLength(): number { return this.fenceLength; }

public isTextCoordinateOp(): boolean {
    return this.openOp === "READ" || this.openOp === "EDIT" || this.openOp === "COPY" || this.openOp === "MOVE"
        || this.openOp === "KILL";
}
}

// {§operation-fences} - three or more backticks open an operation; three is the taught width.
fragment FENCE : '```' '`'* ;
fragment NAME : [A-Za-z0-9_.+-]+ ;
fragment NUM : '-'? [0-9]+ ('.' [0-9]+)? ;
fragment L_PATTERN : '<' NUM (('-' | ',' ' '?) NUM)* '>' ;
fragment LINE_ANCHOR : '@' [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] ;
// {§fence-pairing} — `@` with one to four digits cannot be a hash: it is read as that line.
fragment DIGIT_ANCHOR : '@' [0-9] [0-9]? [0-9]? [0-9]? ;
// {§op-methods-op-dispatch} — `@abcde+1` and a bare `+1` after an anchor are tolerated, never taught (#749).
fragment ANCHOR_OFFSET : LINE_ANCHOR [+-] [0-9]+ ;
fragment RELATIVE_COORD : '+' [0-9]+ ;
fragment RELATIVE_L_PATTERN : '<' NUM ',' ' '? RELATIVE_COORD '>' ;
fragment TEXT_COORD : NUM | ANCHOR_OFFSET | LINE_ANCHOR | DIGIT_ANCHOR | RELATIVE_COORD ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment EOL : '\r'? '\n' ;

// {§operation-fences} - only top-level fences can open statements. The first
// block may terminate a provider preamble without an intervening newline.
OPEN : { this.atLineStart() || !this.reasoning && this.inlineChain }? FENCE NAME { this.operationHeading() }? { this.open(); } -> mode(SLOTS) ;
// {§operation-fences} — the name opens; the ordinary heading lexer reads its aside.
NAKED_OPEN : { this.nakedHeadingHere() }? [A-Z]+ { this.openNaked(); } -> mode(SLOTS) ;
// {§op-shapes} — an enclosing code fence is quotation, including unknown tags and tildes.
// {§fence-pairing} - a bare fence directly under a fence line is that block's orphaned closer: it
// closes nothing and quotes nothing (a malformed heading's block ends at its own line).
ORPHAN_CLOSER : { this.atLineStart() && this.surplusHere() }? FENCE [ \t]* { this.orphanAtLineEnd() }? -> channel(HIDDEN) ;
// {§fence-pairing} - every other fence at a line start quotes to its closer or the end of the input.
// A line-start fence whose line carries more backticks is inline code: it quotes nothing.
INLINE_TAG : { this.atLineStart() && !this.fenceOpens() }? FENCE NAME -> type(TEXT), channel(HIDDEN) ;
SPLIT_OPEN : { this.atLineStart() && this.splitHere() }? FENCE [ \t]* EOL NAME { this.splitOpen(); } -> mode(SLOTS) ;
QUOTE : { this.atLineStart() && this.quotationHere() }? (FENCE NAME? | '~~~' '~'* NAME?) { this.quote(); } -> type(TEXT), channel(HIDDEN), mode(QUOTATION) ;
// {§fence-pairing} - a fence opening no operation is prose outside a block.
WS : [ \t\r\n]+ -> channel(HIDDEN) ;
// {§whitespace-contract} - outside text has no AST or execution semantics.
// {§provider-interface} - a route that delivers reasoning inline declares it, and the
// provider peels that one leading envelope. Here a reasoning tag is prose: no rule in this mode
// crosses a line start unanchored, so no substring found in text can re-read the program after it.
TEXT_RUN : { !this.nakedHeadingHere() }? ~[ \t\r\n`]+ { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;
TEXT_TICK : '`' { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;

// {§whitespace-contract} - the modes below are that chapter's state diagram: DEFAULT, QUOTATION,
// SLOTS, TARGET, METADATA and BODY, and each `mode(...)` action is one of its edges.
mode QUOTATION;
Q_END : { this.closingAfterEol() }? EOL [ \t]* ('```' '`'* | '~~~' '~'*) [ \t]* { this.endQuote(); } -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_EMPTY_END : { this.atLineStart() && this.closingAt(1) }? [ \t]* ('```' '`'* | '~~~' '~'*) [ \t]* { this.endQuote(); } -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_TAG : { this.atLineStart() }? FENCE NAME { this.noteQuoted(); } -> type(TEXT), channel(HIDDEN) ;
Q_RUN : ~[\r\n`~]+ -> type(TEXT), channel(HIDDEN) ;
Q_CHAR : . -> type(TEXT), channel(HIDDEN) ;

mode SLOTS;
// {§fence-pairing} - the next opener on a heading's own line ends this bodyless block and opens.
SLOTS_NEXT_OPENER : { this.slotReady && this.openerFollows() }? [ \t]+ { this.inlineChain = true; } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
// {§fence-pairing} — zero-width characters on a heading line are invisible to the writer too (#758).
SLOTS_INVISIBLE : [\u200B-\u200D\u2060\uFEFF]+ -> skip ;
SLOTS_LPAREN : { this.slotReady }? '(' { this.targetDepth = 0; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACKET : { this.slotReady }? '[' { this.metadataDepth = 0; } -> type(LBRACKET), mode(METADATA) ;
// {§op-shapes} — retain each duration for validation and its possible advisory.
SLOTS_WAIT_SCOPE : { this.slotReady && this.openOp === "WAIT" }? '<' (~[!\r\n>] ~[\r\n>]*)? '>' -> type(L_MARKER) ;
// {§slot-order} - a scope on an operation that takes none is skipped, and named once. An aside (`<!--`) is not a scope.
SLOTS_NO_SCOPE : { this.slotReady && this.scopeless() }? '<' (~[!\r\n>] ~[\r\n>]*)? '>' { this.noteNotation("scope"); } -> skip ;
SLOTS_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_FIND_RELATIVE_L : { this.slotReady && this.openOp === "FIND" }? RELATIVE_L_PATTERN -> type(L_MARKER) ;
// {§parse-recovery} — `42<@abcde>` is the displayed row prefix copied whole; the builder drops the digits.
SLOTS_PREFIXED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? [1-9] [0-9]* TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
SLOTS_ASIDE : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ASIDE) ;
// {§fence-pairing} — an aside that never closes on its line is the aside to the end of the line.
SLOTS_ASIDE_OPEN : { this.slotReady && !this.asideClosesOnLine() }? '<!--' ~[\r\n]* { this.noteUnclosedAside(); } -> type(ASIDE) ;
// {§fence-pairing} — a closing fence with more heading on its line reads as if it
// were not written: the slots after it still belong to this operation (operator, 2026-09-13:
// "If there's no risk of ambiguity, then we add tolerance").
SLOTS_INLINE_CLOSER : { this.slotReady && this.closerWithHeadingAhead() }? FENCE [ \t]* { this.inlineCloserSeen = true; } -> skip ;
SLOTS_END : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§parse-recovery} - `→ path`, an address as the log's receipt heading shows it, is the target slot.
SLOTS_ARROW_TARGET : { this.slotReady && this.openOp !== "NOTE" }? '\u2192' [ \t]* ~[ \t\r\n<[(`\u00B7] ~[ \t\r\n<[`]* { this.targetClosed(); this.noteNotation("arrow"); } -> type(ARROW_TARGET) ;
// {§parse-recovery} - ` · N`, the token charge the log's heading shows, is no slot: skipped.
SLOTS_CHARGE : { this.slotReady && this.chargeAhead() }? '\u00B7' [ \t]* ([0-9]+ ([ \t]+ 'tokens')?)? { this.noteNotation("charge"); } -> skip ;
// {§parse-recovery} - ` · words` before a comment on the same line is stray text, skipped and named: the
// comment is the aside (#1005).
SLOTS_DOT_BEFORE_ASIDE : { this.slotReady && !this.chargeAhead() && this.asideCommentLater() }? '\u00B7' ( ~[\r\n`<] | '<' ~[!\r\n`] )* { this.noteNotation("stray"); } -> skip ;
// {§parse-recovery} - ` · words` after the slots is a note on the operation: the aside.
SLOTS_DOT_ASIDE : { this.slotReady && !this.chargeAhead() && !this.asideCommentLater() }? '\u00B7' [ \t]* ~[ \t\r\n`] ~[\r\n`]* { this.noteNotation("aside"); } -> type(ASIDE) ;
// {§parse-recovery} - an EDIT's `@abcde` (or `@abcde,@fghij`) alone where the scope goes is that scope.
SLOTS_BARE_ANCHOR : { this.slotReady && this.openOp === "EDIT" && this.bareAnchorAhead() }? LINE_ANCHOR (',' ' '? LINE_ANCHOR)? { this.noteNotation("anchor"); this.text = "<" + this.text + ">"; } -> type(L_MARKER) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<`] { this.inlineBody = true; } -> type(BODY_TEXT), mode(BODY) ;
// {§fence-pairing} — a single backtick before a matcher sigil quotes that matcher, never a fence (#758).
SLOTS_TICK_TEXT : { this.slotReady && this.inlineBodyAhead() && [0x2F, 0x24, 0x7E, 0x26, 0x5E].includes(this.inputStream.LA(2)) }? '`' { this.inlineBody = true; } -> type(BODY_TEXT), mode(BODY) ;
// {§fence-pairing} — the block already met its closer, so its line ending ends it.
SLOTS_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_NEXT_HEADING : { this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;

mode TARGET;
TARGET_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// An unclosed slot ends with its heading line: the statement is one bounded error and the next
// line lexes fresh, so siblings survive ({§operation-fences}); only EOF inside the slot is a tail.
TARGET_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<`\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_TEXT_SCOPE : { this.isTextCoordinateOp() }? TEXT_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_FIND_RELATIVE_SCOPE : { this.openOp === "FIND" }? RELATIVE_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
// {§parse-recovery} — the displayed row prefix copied whole after an operand path.
TARGET_PREFIXED_TEXT_SCOPE : { this.isTextCoordinateOp() }? [1-9] [0-9]* TEXT_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_SCOPE : { this.openOp === "FIND" || this.execFence || this.openOp === "SEND" }? L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_TICK : '`' -> type(TARGET_TEXT) ;
TARGET_END : ')' { this.targetClosed(); } -> type(RPAREN), mode(SLOTS) ;

mode METADATA;
METADATA_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_STRING : '"' ('\\' ~[\r\n] | ~["\\\r\n])* '"' -> type(METADATA_TEXT) ;
METADATA_INNER : ~[[\]"`\r\n]+ -> type(METADATA_TEXT) ;
METADATA_TICK : '`' -> type(METADATA_TEXT) ;
METADATA_QUOTE : '"' -> type(METADATA_TEXT) ;
METADATA_NEST_OPEN : '[' { this.metadataDepth++; } -> type(METADATA_TEXT) ;
METADATA_NEST_END : { this.metadataDepth > 0 }? ']' { this.metadataDepth--; } -> type(METADATA_TEXT) ;
METADATA_END : ']' { this.slotReady = true; } -> type(RBRACKET), mode(SLOTS) ;

mode BODY;
// {§operation-fences} the block's own closer; {§operation-fences} a heading ends it instead, and
// the EOL becomes a synthetic SECTION_END whose text carries no backtick ({§operation-fences}).
B_END : { this.closingAfterEol() }? EOL [ \t]* FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_EMPTY_END : { (this.atLineStart() || this.inlineBody) && this.closingAt(1) }? [ \t]* FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§fence-pairing} — the heading already carried its closer, so the matcher or inline
// body after it ends with that line and the block never reaches for the next operation.
B_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§operation-fences} - a naked block also closes at its own name alone on a line.
B_NAKED_END : { this.naked && this.nakedCloserAfterEol() }? EOL [ \t]* [A-Z]+ [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_NEXT_HEADING : { this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n`]+ -> type(BODY_TEXT) ;
B_TICK : '`' -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_LF : '\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_CR : '\r' -> type(BODY_TEXT) ;
