lexer grammar plurnkLexer;

tokens {
    OPEN_FIND, OPEN_READ, OPEN_EDIT, OPEN_COPY, OPEN_MOVE,
    OPEN_SEND, OPEN_TASK,
    OPEN_EXEC, OPEN_BARE, OPEN_WORK, OPEN_FORK, OPEN_KILL,
    OPEN_LOOK,
    LPAREN, RPAREN, LBRACKET, RBRACKET, L_MARKER, COMBINED_L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ASIDE
}

@lexer::members {
private openOp: string = "";
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private fenceLength: number = 0;
private fenceDelimiter: string = "";
private started: boolean = false;
// {§inline-chain} — a closer on the heading line may be followed by the next opener on the same line.
private inlineChain: boolean = false;
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
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutors.has(name));
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
    return Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutors.has(name);
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
    SEND: plurnkLexer.OPEN_SEND, EXEC: plurnkLexer.OPEN_EXEC, BARE: plurnkLexer.OPEN_BARE,
    TASK: plurnkLexer.OPEN_TASK,
    WORK: plurnkLexer.OPEN_WORK, FORK: plurnkLexer.OPEN_FORK, KILL: plurnkLexer.OPEN_KILL,
    LOOK: plurnkLexer.OPEN_LOOK,
};

private open(implicitName?: string): void {
    this.fenceLength = 0;
    while (this.text.charCodeAt(this.fenceLength) === 0x60) this.fenceLength++;
    // {§numeric-delimiter} - digits between the backticks and the name identify the block.
    let digits = this.fenceLength;
    while (this.text.charCodeAt(digits) >= 0x30 && this.text.charCodeAt(digits) <= 0x39) digits++;
    this.fenceDelimiter = this.text.slice(this.fenceLength, digits);
    const name = implicitName ?? this.text.slice(digits);
    const native = Object.hasOwn(plurnkLexer.OPERATIONS, name) ? plurnkLexer.OPERATIONS[name] : undefined;
    this.openOp = native === undefined ? "EXEC" : name;
    this.type = native ?? plurnkLexer.OPEN_EXEC;
    this.inlineChain = false;
    this.openHeading = this.text;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.started = true;
    this.slotReady = true;
    this.metadataReady = this.openOp === "EXEC";
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

// {§fence-closer} - a closer is a line of at least the opener's backticks carrying exactly the
// opener's numeric delimiter (none when the opener had none). Count is CommonMark's rule; the
// delimiter is what lets an equal-count block nest ({§numeric-delimiter}).
private closingAt(offset: number): boolean {
    if (this.inputStream.LA(offset === 1 ? -1 : offset - 1) === 0x60) return false;
    offset = this.skipHorizontal(offset);
    let cursor = offset;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    if (cursor - offset < this.fenceLength) return false;
    let digits = "";
    while (this.inputStream.LA(cursor) >= 0x30 && this.inputStream.LA(cursor) <= 0x39) {
        digits += String.fromCharCode(this.inputStream.LA(cursor));
        cursor++;
    }
    if (digits !== this.fenceDelimiter) return false;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null) return true;
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
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutors.has(name));
}

// {§fence-heading-in-body} - a fence line of four or more backticks naming an operation or a known
// executor is a heading wherever it stands: it ends the open block without closing it, so a
// glued opener (eight backticks then READ) can never swallow the turn. A delimited block is exempt: its
// delimiter says everything up to its own closer is body ({§numeric-delimiter}).
private headingAt(offset: number): boolean {
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
    if (!Object.hasOwn(plurnkLexer.OPERATIONS, name) && !this.knownExecutors.has(name)) return false;
    const next = this.inputStream.LA(cursor);
    return next <= 0 || next === 0x20 || next === 0x09 || next === 0x28 || next === 0x3C || next === 0x5B
        || this.offsetAfterEol(cursor) !== null;
}

private headingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.headingAt(this.skipHorizontal(after));
}

private closingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.closingAt(this.skipHorizontal(after));
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
    // {§bare-matcher-lift} - a sigil opens the grep spelling of a matcher, not a misplaced body.
    const first = this.text.charCodeAt(0);
    if (first === 0x2F || first === 0x24 || first === 0x7E || first === 0x26) return;
    this.inlineBodies.push({ line: this.getOpenTagLine(), column: this.getOpenTagColumn(), heading: this.getOpenHeading() });
}

public takeInlineBodies(): Array<{ line: number; column: number; heading: string }> {
    const taken = this.inlineBodies;
    this.inlineBodies = [];
    return taken;
}

public getOpenTag(): string { return this.openOp; }
public getOpenOp(): string { return this.openOp; }
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
fragment TEXT_COORD : NUM | LINE_ANCHOR | DIGIT_ANCHOR ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment COMBINED_LINE_COORD : LINE_ANCHOR (':' | ' ') [1-9] [0-9]* ;
fragment COMBINED_TEXT_COORD : TEXT_COORD | COMBINED_LINE_COORD ;
fragment COMBINED_TEXT_L_PATTERN : '<' COMBINED_TEXT_COORD (',' ' '? COMBINED_TEXT_COORD)* '>' ;
fragment EOL : '\r'? '\n' ;

// {§fence-boundary} - only top-level fences can open statements. The first
// block may terminate a provider preamble without an intervening newline.
OPEN : { this.atLineStart() || !this.started || this.inlineChain }? FENCE [0-9]* NAME { this.knownHeading() }? { this.open(); } -> mode(SLOTS) ;
// {§interstitial-fence} - a fence naming nothing known, or nothing at all, is prose outside a block.
UNKNOWN_TAG : { this.atLineStart() || !this.started }? FENCE [0-9]* NAME { this.noteUnknownTag(); } -> type(TEXT), channel(HIDDEN) ;
WS : [ \t\r\n]+ -> channel(HIDDEN) ;
// {§whitespace-contract} - outside text has no AST or execution semantics.
THINK_BLOCK : '<think>' .*? '</think>' -> type(TEXT), channel(HIDDEN) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT), channel(HIDDEN) ;
TEXT_RUN : ~[ \t\r\n`]+ { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;
TEXT_TICK : '`' { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;

mode SLOTS;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
SLOTS_LPAREN : { this.slotReady }? '(' { this.targetDepth = 0; this.metadataReady = false; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACKET : { this.slotReady && this.metadataReady }? '[' { this.metadataDepth = 0; } -> type(LBRACKET), mode(METADATA) ;
SLOTS_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(COMBINED_L_MARKER) ;
SLOTS_ASIDE : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ASIDE) ;
// {§unclosed-aside} — an aside that never closes on its line is the aside to the end of the line.
SLOTS_ASIDE_OPEN : { this.slotReady && !this.asideClosesOnLine() }? '<!--' ~[\r\n]* { this.noteUnclosedAside(); } -> type(ASIDE) ;
SLOTS_END : { this.closingAt(1) }? FENCE [0-9]* [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<`] { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
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
TARGET_SCOPE : { this.openOp === "FIND" || this.openOp === "EXEC" || this.openOp === "SEND" }? L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
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
B_NEXT_HEADING : { this.fenceDelimiter === "" && this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n`]+ -> type(BODY_TEXT) ;
B_TICK : '`' -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_LF : '\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_CR : '\r' -> type(BODY_TEXT) ;
