lexer grammar plurnkLexer;

tokens {
    OPEN_FIND, OPEN_READ, OPEN_EDIT, OPEN_COPY, OPEN_MOVE,
    OPEN_SEND, OPEN_NOTE, OPEN_WAIT,
    OPEN_EXEC, OPEN_BARE, OPEN_WORK, OPEN_FORK, OPEN_KILL,
    OPEN_LOOK,
    LPAREN, RPAREN, LBRACKET, RBRACKET, L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ASIDE
}

@lexer::members {
private openOp: string = "";
// {§executor-runtime-declaration} — the opener names a runtime rather than an operation keyword.
private execFence: boolean = false;
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private fenceLength: number = 0;
private fenceCharacter: number = 0x60;
private fenceDelimiter: string = "";
private openFenceStart: number = 0;
private balancedEnds: Map<number, number | null> = new Map();
private fenceLines: Array<{ start: number; width: number; delimiter: string; character: number; tail: string } | null> | null = null;
// {§reasoning-notes} — quotations are opaque; program-boundary recovery is not note extraction.
public reasoning: boolean = false;
private started: boolean = false;
// {§inline-chain} — a closer on the heading line may be followed by the next opener on the same line.
private inlineChain: boolean = false;
// {§transparent-inline-closer} — a closer already consumed mid-heading, so the line's end closes.
private inlineCloserSeen: boolean = false;
private unclosedAsides: Array<{ line: number; column: number }> = [];

// After a closer's text, does an opener (backticks, digits, a known name) follow on the same line?
private openerFollows(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    let ticks = 0;
    while (this.inputStream.LA(cursor) === 0x60) { ticks++; cursor++; }
    if (ticks < 3) return false;
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) cursor++;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; cursor++;
    }
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name));
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
// {§fence-heading-in-body} - tags that end an open block from inside it; the host adds executors.
public knownExecutors: Set<string> = new Set(["sh"]);
// {§executor-case} - an executor tag matches its registered name in any case (`SH` is `sh`).
private knownExecutor(name: string): boolean {
    if (this.knownExecutors.has(name)) return true;
    const lower = name.toLowerCase();
    for (const known of this.knownExecutors) if (known.toLowerCase() === lower) return true;
    return false;
}
private slotReady: boolean = false;
private targetDepth: number = 0;
private metadataDepth: number = 0;
private metadataReady: boolean = false;
private inlineBody: boolean = false;
private inlineBodies: Array<{ line: number; column: number; heading: string }> = [];
private unknownTags: Array<{ line: number; column: number; tag: string }> = [];

// {§interstitial-fence} - only a native operation or a known executor opens a block.
private knownHeading(): boolean {
    const name = this.text.replace(/^\x60+[0-9]*/, "");
    if (this.reasoning) return name === "NOTE";
    return Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name);
}

private noteUnknownTag(): void {
    this.unknownTags.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn, tag: this.text.replace(/^\x60+[0-9]*/, "") });
}

public takeUnknownTags(): Array<{ line: number; column: number; tag: string }> {
    const taken = this.unknownTags;
    this.unknownTags = [];
    return taken;
}

private static readonly OPERATIONS: Readonly<Record<string, number>> = {
    FIND: plurnkLexer.OPEN_FIND, READ: plurnkLexer.OPEN_READ,
    EDIT: plurnkLexer.OPEN_EDIT, COPY: plurnkLexer.OPEN_COPY, MOVE: plurnkLexer.OPEN_MOVE,
    SEND: plurnkLexer.OPEN_SEND, BARE: plurnkLexer.OPEN_BARE,
    NOTE: plurnkLexer.OPEN_NOTE, WAIT: plurnkLexer.OPEN_WAIT,
    WORK: plurnkLexer.OPEN_WORK, FORK: plurnkLexer.OPEN_FORK, KILL: plurnkLexer.OPEN_KILL,
    LOOK: plurnkLexer.OPEN_LOOK,
};

private open(implicitName?: string): void {
    this.fenceLength = 0;
    this.fenceCharacter = this.text.charCodeAt(0);
    while (this.text.charCodeAt(this.fenceLength) === this.fenceCharacter) this.fenceLength++;
    // {§numeric-delimiter} - digits between the backticks and the name identify the block.
    let digits = this.fenceLength;
    while (this.text.charCodeAt(digits) >= 0x30 && this.text.charCodeAt(digits) <= 0x39) digits++;
    this.fenceDelimiter = this.text.slice(this.fenceLength, digits);
    const name = implicitName ?? this.text.slice(digits);
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
    this.metadataReady = this.execFence || this.openOp === "SEND" || this.openOp === "WAIT";
    this.inlineBody = false;
}

// {§indented-fences} - a fence line may carry leading horizontal whitespace; the line still
// starts there for every fence purpose (CommonMark allows three spaces; this allows any).
private atLineStart(): boolean {
    for (let back = 1; ; back++) {
        const c = this.inputStream.LA(-back);
        if (c <= 0 || c === 0x0A || c === 0x0D) return true;
        if (c !== 0x20 && c !== 0x09) return false;
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

// {§balanced-fences} — retain complete nested blocks before trying local missing-closer
// recovery. Cache descendants as well as the root so an unclosed prefix is scanned once.
private balancedEnd(): number | null {
    if (this.fenceDelimiter !== "") return null;
    if (this.balancedEnds.has(this.openFenceStart)) return this.balancedEnds.get(this.openFenceStart)!;
    if (this.fenceLines === null) {
        let start = 0;
        this.fenceLines = this.inputStream.toString().split("\n").map((line) => {
            const match = /^([ \t]*)(\x60{3,}|~{3,})([0-9]*)(.*?)[ \t\r]*$/u.exec(line);
            const fence = match === null ? null : {
                start: start + match[1].length,
                width: match[2].length,
                character: match[2].charCodeAt(0),
                delimiter: match[3],
                tail: match[4],
            };
            // ANTLR indexes Unicode code points, not JavaScript UTF-16 units.
            start += [...line].length + 1;
            return fence;
        });
    }
    const stack = [{ start: this.openFenceStart, width: this.fenceLength, delimiter: this.fenceDelimiter, character: this.fenceCharacter }];
    for (let index = this.openHeadingLine; index < this.fenceLines.length; index++) {
        const fence = this.fenceLines[index];
        if (fence === null) continue;
        const top = stack[stack.length - 1];
        const continuation = this.continuedFence(fence);
        if ((fence.tail === "" || continuation !== null) && fence.character === top.character && fence.width >= top.width && fence.delimiter === top.delimiter) {
            stack.pop();
            this.balancedEnds.set(top.start, fence.start);
            if (stack.length === 0) return fence.start;
            if (continuation !== null) {
                const nested = this.nestedFence(continuation);
                if (nested !== null) stack.push(nested);
            }
            continue;
        }
        // Numeric delimiters explicitly protect arbitrary (including unfinished) examples.
        if (top.delimiter !== "" || fence.tail.trim() === "") continue;
        const nested = this.nestedFence(fence);
        if (nested !== null) stack.push(nested);
    }
    for (const fence of stack) this.balancedEnds.set(fence.start, null);
    return null;
}

private continuedFence(fence: { start: number; width: number; delimiter: string; tail: string }): { start: number; width: number; delimiter: string; character: number; tail: string } | null {
    const match = /^([ \t]*)(\x60{3,})([0-9]*)([A-Za-z0-9_.+-]+)(.*)$/u.exec(fence.tail);
    if (match === null || !Object.hasOwn(plurnkLexer.OPERATIONS, match[4]) && !this.knownExecutor(match[4])) return null;
    return { start: fence.start + fence.width + fence.delimiter.length + match[1].length, width: match[2].length, delimiter: match[3], character: 0x60, tail: match[4] + match[5] };
}

private nestedFence(fence: { start: number; width: number; delimiter: string; character: number; tail: string }): { start: number; width: number; delimiter: string; character: number } | null {
    if (!/[\x60~]{3}/u.test(fence.tail)) return fence;
    const name = /^[A-Za-z0-9_.+-]+/u.exec(fence.tail)?.[0];
    if (name === undefined) return fence;
    // Reuse the heading lexer: fences quoted in a target, metadata or aside are not closers.
    // Literal examples need only a lexical boundary; their slot diagnostics stay opaque.
    const lexer = new plurnkLexer(antlr.CharStream.fromString(String.fromCharCode(fence.character).repeat(fence.width) + fence.delimiter + fence.tail + "\n"));
    lexer.knownExecutors = new Set([...this.knownExecutors, name]);
    lexer.reasoning = fence.character !== 0x60;
    lexer.removeErrorListeners();
    let closed = false;
    for (let token = lexer.nextToken(); token.type !== Token.EOF; token = lexer.nextToken()) {
        if (token.type === plurnkLexer.SECTION_END && token.text?.includes("\x60")) closed = true;
    }
    if (lexer.mode === plurnkLexer.DEFAULT_MODE && (closed || lexer.inlineCloserSeen)) return null;
    return { start: fence.start + lexer.openFenceStart, width: lexer.fenceLength, delimiter: lexer.fenceDelimiter, character: lexer.fenceCharacter };
}

// {§fence-closer} - a closer is a line of at least the opener's backticks carrying exactly the
// opener's numeric delimiter (none when the opener had none). Count is CommonMark's rule; the
// delimiter is what lets an equal-count block nest ({§numeric-delimiter}).
private closingAt(offset: number): boolean {
    if (this.inputStream.LA(offset === 1 ? -1 : offset - 1) === this.fenceCharacter) return false;
    offset = this.skipHorizontal(offset);
    if ((this.mode === plurnkLexer.BODY || this.mode === plurnkLexer.QUOTATION) && !(this.inlineBody && offset === 1)) {
        const end = this.balancedEnd();
        if (end !== null && this.inputStream.index + offset - 1 !== end) return false;
    }
    let cursor = offset;
    while (this.inputStream.LA(cursor) === this.fenceCharacter) cursor++;
    if (cursor - offset < this.fenceLength) return false;
    let digits = "";
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) {
        digits += String.fromCharCode(this.inputStream.LA(cursor));
        cursor++;
    }
    if (digits !== this.fenceDelimiter) return false;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null) return true;
    if (this.reasoning) return false;
    // {§closer-aside} — a closer followed on its line by one aside and nothing else still closes;
    // read as body, that line would be written into the edited resource (#758, dogfood item 17).
    if (this.asideToLineEnd(cursor)) return true;
    // {§inline-chain} — a closer followed on its line by the next opener still closes.
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let at = cursor + ticks;
    while (this.inputStream.LA(at) >= 0x30 && this.inputStream.LA(at) <= 0x39) at++;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(at);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; at++;
    }
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name));
}

// {§fence-heading-in-body} — a known heading recovers an unclosed block only after
// {§balanced-fences} has ruled out complete nesting. Explicit delimiters remain opaque.
private headingAt(offset: number): boolean {
    if (this.reasoning) return false;
    let cursor = offset;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    if (cursor - offset < 4) return false;
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) cursor++;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch;
        cursor++;
    }
    if (name === "") return false;
    if (!Object.hasOwn(plurnkLexer.OPERATIONS, name) && !this.knownExecutor(name)) return false;
    const next = this.inputStream.LA(cursor);
    return next <= 0 || next === 0x20 || next === 0x09 || next === 0x28 || next === 0x3C || next === 0x5B
        || this.offsetAfterEol(cursor) !== null;
}

private headingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.balancedEnd() === null && this.headingAt(this.skipHorizontal(after));
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
    return after !== null && this.closingAt(this.skipHorizontal(after));
}

// {§transparent-inline-closer} — true when the run here closes the open block but more of the
// heading follows on the line and it is not the next opener. Slots, matchers, asides and option
// blocks all still belong to this heading, so the closer is skipped and reading continues.
private closerWithHeadingAhead(): boolean {
    if (this.inputStream.LA(-1) === 0x60) return false;
    let cursor = 1;
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < this.fenceLength) return false;
    let at = cursor + ticks;
    let digits = "";
    while (this.inputStream.LA(at) >= 0x30 && this.inputStream.LA(at) <= 0x39) {
        digits += String.fromCharCode(this.inputStream.LA(at));
        at++;
    }
    if (digits !== this.fenceDelimiter) return false;
    while (this.inputStream.LA(at) === 0x20 || this.inputStream.LA(at) === 0x09) at++;
    // End of line or input: the ordinary closer owns it.
    if (this.inputStream.LA(at) <= 0 || this.offsetAfterEol(at) !== null) return false;
    // The next opener on the line: {§inline-chain} owns it.
    return !this.openerFollowsAt(at);
}

// Does an opener (backticks, optional digits, a known name) begin at this offset?
private openerFollowsAt(at: number): boolean {
    let ticks = 0;
    while (this.inputStream.LA(at + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let cursor = at + ticks;
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) cursor++;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x28 || c === 0x3c || c === 0x5b || c === 0x60) break;
        name += String.fromCharCode(c);
        cursor++;
    }
    return Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name);
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

private noteInlineBody(): void {
    this.inlineBody = true;
    // {§naked-pattern} - a sigil is a matcher on any heading, and every heading-line word on FIND,
    // READ or KILL is one, so only a bodied operation's stray heading text is worth an advisory.
    const first = this.text.charCodeAt(0) === 0x60 ? this.inputStream.LA(1) : this.text.charCodeAt(0);
    if (first === 0x2F || first === 0x24 || first === 0x7E || first === 0x26 || first === 0x5E) return;
    if (this.openOp === "FIND" || this.openOp === "READ" || this.openOp === "KILL") return;
    this.inlineBodies.push({ line: this.getOpenTagLine(), column: this.getOpenTagColumn(), heading: this.getOpenHeading() });
}

public takeInlineBodies(): Array<{ line: number; column: number; heading: string }> {
    const taken = this.inlineBodies;
    this.inlineBodies = [];
    return taken;
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
        || this.openOp === "KILL" || this.openOp === "LOOK";
}
}

fragment FENCE : '```' '`'* ;
fragment NAME : [A-Za-z0-9_.+-]+ ;
fragment NUM : '-'? [0-9]+ ('.' [0-9]+)? ;
fragment L_PATTERN : '<' NUM (('-' | ',' ' '?) NUM)* '>' ;
fragment LINE_ANCHOR : '@' [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] ;
// {§anchor-digits} — `@` with one to four digits cannot be a hash: it is read as that line.
fragment DIGIT_ANCHOR : '@' [0-9] [0-9]? [0-9]? [0-9]? ;
// {§anchor-offset} — `@abcde+1` and a bare `+1` after an anchor are tolerated, never taught (#749).
fragment ANCHOR_OFFSET : LINE_ANCHOR [+-] [0-9]+ ;
fragment RELATIVE_COORD : '+' [0-9]+ ;
fragment TEXT_COORD : NUM | ANCHOR_OFFSET | LINE_ANCHOR | DIGIT_ANCHOR | RELATIVE_COORD ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment COMBINED_LINE_COORD : LINE_ANCHOR (':' | ' ') [1-9] [0-9]* ;
fragment COMBINED_TEXT_COORD : TEXT_COORD | COMBINED_LINE_COORD ;
fragment COMBINED_TEXT_L_PATTERN : '<' COMBINED_TEXT_COORD (',' ' '? COMBINED_TEXT_COORD)* '>' ;
fragment EOL : '\r'? '\n' ;

// {§fence-boundary} - only top-level fences can open statements. The first
// block may terminate a provider preamble without an intervening newline.
OPEN : { this.atLineStart() || !this.reasoning && (!this.started || this.inlineChain) }? FENCE [0-9]* NAME { this.knownHeading() }? { this.open(); } -> mode(SLOTS) ;
// {§reasoning-notes} — an enclosing code fence is quotation, including unknown tags and tildes.
REASONING_QUOTE : { this.reasoning && this.atLineStart() }? (FENCE [0-9]* NAME? | '~~~' '~'* NAME?) { !this.knownHeading() }? { this.open(); } -> type(TEXT), channel(HIDDEN), mode(QUOTATION) ;
// {§interstitial-fence} - a fence naming nothing known, or nothing at all, is prose outside a block.
UNKNOWN_TAG : { this.atLineStart() || !this.started }? FENCE [0-9]* NAME { this.noteUnknownTag(); } -> type(TEXT), channel(HIDDEN) ;
WS : [ \t\r\n]+ -> channel(HIDDEN) ;
// {§whitespace-contract} - outside text has no AST or execution semantics.
THINK_BLOCK : '<think>' .*? '</think>' -> type(TEXT), channel(HIDDEN) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT), channel(HIDDEN) ;
TEXT_RUN : ~[ \t\r\n`]+ { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;
TEXT_TICK : '`' { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;

mode QUOTATION;
Q_END : { this.closingAfterEol() }? EOL [ \t]* ('```' '`'* | '~~~' '~'*) [0-9]* [ \t]* -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_EMPTY_END : { this.atLineStart() && this.closingAt(1) }? [ \t]* ('```' '`'* | '~~~' '~'*) [0-9]* [ \t]* -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_RUN : ~[\r\n`~]+ -> type(TEXT), channel(HIDDEN) ;
Q_CHAR : . -> type(TEXT), channel(HIDDEN) ;

mode SLOTS;
// {§one-line-turn} - the next opener on a heading's own line ends this bodyless block and opens.
SLOTS_NEXT_OPENER : { this.slotReady && this.openerFollows() }? [ \t]+ { this.inlineChain = true; } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
// {§heading-slot-order} — zero-width characters on a heading line are invisible to the writer too (#758).
SLOTS_INVISIBLE : [\u200B-\u200D\u2060\uFEFF]+ -> skip ;
SLOTS_LPAREN : { this.slotReady }? '(' { this.targetDepth = 0; this.metadataReady = false; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACKET : { this.slotReady && this.metadataReady }? '[' { this.metadataDepth = 0; } -> type(LBRACKET), mode(METADATA) ;
// {§send-wait-scope} — whatever a WAIT names in its scope slot is skipped unread, never refused
// (#756): the park needs no selection. An aside (`<!--`) is not a scope.
SLOTS_WAIT_SCOPE : { this.slotReady && this.openOp === "WAIT" }? '<' (~[!\r\n>] ~[\r\n>]*)? '>' -> skip ;
SLOTS_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
// {§combined-anchor-tolerance} — `<@abcde 42>` is the anchor with its displayed line number; the builder drops the number.
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_ASIDE : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ASIDE) ;
// {§unclosed-aside} — an aside that never closes on its line is the aside to the end of the line.
SLOTS_ASIDE_OPEN : { this.slotReady && !this.asideClosesOnLine() }? '<!--' ~[\r\n]* { this.noteUnclosedAside(); } -> type(ASIDE) ;
// {§transparent-inline-closer} — a closing fence with more heading on its line reads as if it
// were not written: the slots after it still belong to this operation (operator, 2026-09-13:
// "If there's no risk of ambiguity, then we add tolerance").
SLOTS_INLINE_CLOSER : { this.slotReady && this.closerWithHeadingAhead() }? FENCE [0-9]* [ \t]* { this.inlineCloserSeen = true; } -> skip ;
SLOTS_END : { this.closingAt(1) }? FENCE [0-9]* [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<`] { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
// {§heading-slot-order} — a single backtick before a matcher sigil quotes that matcher, never a fence (#758).
SLOTS_TICK_TEXT : { this.slotReady && this.inlineBodyAhead() && [0x2F, 0x24, 0x7E, 0x26, 0x5E].includes(this.inputStream.LA(2)) }? '`' { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
// {§transparent-inline-closer} — the block already met its closer, so its line ending ends it.
SLOTS_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_NEXT_HEADING : { this.fenceDelimiter === "" && this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;

mode TARGET;
TARGET_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// An unclosed slot ends with its heading line: the statement is one bounded error and the next
// line lexes fresh, so siblings survive ({§closer-fallback}); only EOF inside the slot is a tail.
TARGET_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<`\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_TEXT_SCOPE : { this.isTextCoordinateOp() }? TEXT_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_SCOPE : { this.openOp === "FIND" || this.execFence || this.openOp === "SEND" }? L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_TICK : '`' -> type(TARGET_TEXT) ;
TARGET_END : ')' { this.slotReady = true; this.metadataReady = true; } -> type(RPAREN), mode(SLOTS) ;

mode METADATA;
METADATA_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_STRING : '"' ('\\' ~[\r\n] | ~["\\\r\n])* '"' -> type(METADATA_TEXT) ;
METADATA_INNER : ~[[\]"`\r\n]+ -> type(METADATA_TEXT) ;
METADATA_TICK : '`' -> type(METADATA_TEXT) ;
METADATA_QUOTE : '"' -> type(METADATA_TEXT) ;
METADATA_NEST_OPEN : '[' { this.metadataDepth++; } -> type(METADATA_TEXT) ;
METADATA_NEST_END : { this.metadataDepth > 0 }? ']' { this.metadataDepth--; } -> type(METADATA_TEXT) ;
METADATA_END : ']' { this.slotReady = true; this.metadataReady = true; } -> type(RBRACKET), mode(SLOTS) ;

mode BODY;
// {§fence-closer} the block's own closer; {§fence-heading-in-body} a heading ends it instead, and
// the EOL becomes a synthetic SECTION_END whose text carries no backtick ({§closer-fallback}).
B_END : { this.closingAfterEol() }? EOL [ \t]* FENCE [0-9]* [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_EMPTY_END : { (this.atLineStart() || this.inlineBody) && this.closingAt(1) }? [ \t]* FENCE [0-9]* [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§transparent-inline-closer} — the heading already carried its closer, so the matcher or inline
// body after it ends with that line and the block never reaches for the next operation.
B_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_NEXT_HEADING : { this.fenceDelimiter === "" && this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n`]+ -> type(BODY_TEXT) ;
B_TICK : '`' -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_LF : '\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_CR : '\r' -> type(BODY_TEXT) ;
