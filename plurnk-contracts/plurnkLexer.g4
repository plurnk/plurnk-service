lexer grammar plurnkLexer;

tokens {
    OPEN_FIND, OPEN_READ, OPEN_EDIT, OPEN_COPY, OPEN_MOVE,
    OPEN_SEND, OPEN_NEXT, OPEN_WAIT, OPEN_DONE, OPEN_FAIL,
    OPEN_EXEC, OPEN_BARE, OPEN_WORK, OPEN_FORK, OPEN_KILL,
    OPEN_LOOK, OPEN_BUFF,
    LPAREN, RPAREN, LBRACE, RBRACE, L_MARKER, COMBINED_L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ANNOTATION
}

@lexer::members {
private openOp: string = "";
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private fenceLength: number = 0;
private started: boolean = false;
private slotReady: boolean = false;
private targetDepth: number = 0;
private metadataDepth: number = 0;
private metadataReady: boolean = false;
private inlineBody: boolean = false;
private inlineBodies: Array<{ line: number; column: number; heading: string }> = [];

private static readonly OPERATIONS: Readonly<Record<string, number>> = {
    FIND: plurnkLexer.OPEN_FIND, READ: plurnkLexer.OPEN_READ,
    EDIT: plurnkLexer.OPEN_EDIT, COPY: plurnkLexer.OPEN_COPY, MOVE: plurnkLexer.OPEN_MOVE,
    SEND: plurnkLexer.OPEN_SEND, EXEC: plurnkLexer.OPEN_EXEC, BARE: plurnkLexer.OPEN_BARE,
    NEXT: plurnkLexer.OPEN_NEXT, WAIT: plurnkLexer.OPEN_WAIT,
    DONE: plurnkLexer.OPEN_DONE, FAIL: plurnkLexer.OPEN_FAIL,
    WORK: plurnkLexer.OPEN_WORK, FORK: plurnkLexer.OPEN_FORK, KILL: plurnkLexer.OPEN_KILL,
    LOOK: plurnkLexer.OPEN_LOOK, BUFF: plurnkLexer.OPEN_BUFF,
};

private open(): void {
    this.fenceLength = 0;
    while (this.text.charCodeAt(this.fenceLength) === 0x60) this.fenceLength++;
    const name = this.text.slice(this.fenceLength);
    const native = Object.hasOwn(plurnkLexer.OPERATIONS, name) ? plurnkLexer.OPERATIONS[name] : undefined;
    this.openOp = native === undefined ? "EXEC" : name;
    this.type = native ?? plurnkLexer.OPEN_EXEC;
    this.openHeading = this.text;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.started = true;
    this.slotReady = true;
    this.metadataReady = this.openOp === "EXEC";
    this.inlineBody = false;
}

private offsetAfterEol(offset: number): number | null {
    if (this.inputStream.LA(offset) === 0x0D && this.inputStream.LA(offset + 1) === 0x0A) return offset + 2;
    return this.inputStream.LA(offset) === 0x0A ? offset + 1 : null;
}

private closingAt(offset: number): boolean {
    let cursor = offset;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    if (cursor - offset !== this.fenceLength) return false;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    return this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null;
}

private closingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.closingAt(after);
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
fragment TEXT_COORD : NUM | LINE_ANCHOR ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment COMBINED_LINE_COORD : LINE_ANCHOR (':' | ' ') [1-9] [0-9]* ;
fragment COMBINED_TEXT_COORD : TEXT_COORD | COMBINED_LINE_COORD ;
fragment COMBINED_TEXT_L_PATTERN : '<' COMBINED_TEXT_COORD (',' ' '? COMBINED_TEXT_COORD)* '>' ;
fragment EOL : '\r'? '\n' ;

// {§fence-boundary} — only top-level fences can open statements. The first
// block may terminate a provider preamble without an intervening newline.
OPEN : { this.column === 0 || !this.started }? FENCE NAME { this.open(); } -> mode(SLOTS) ;
WS : [ \t\r\n]+ -> channel(HIDDEN) ;
THINK_BLOCK : '<think>' .*? '</think>' -> type(TEXT) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT) ;
TEXT_RUN : ~[ \t\r\n`]+ -> type(TEXT) ;
TEXT_TICK : '`' -> type(TEXT) ;

mode SLOTS;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
SLOTS_LPAREN : { this.slotReady }? '(' { this.targetDepth = 0; this.metadataReady = false; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACE : { this.slotReady && this.metadataReady }? '{' { this.metadataDepth = 0; } -> type(LBRACE), mode(METADATA) ;
SLOTS_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(COMBINED_L_MARKER) ;
SLOTS_ANNOTATION : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ANNOTATION) ;
SLOTS_END : { this.closingAt(1) }? FENCE [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<`] { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
SLOTS_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;

mode TARGET;
TARGET_FENCE : { this.closingAt(1) }? FENCE [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
TARGET_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<`\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_TEXT_SCOPE : { this.isTextCoordinateOp() }? TEXT_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_SCOPE : { this.openOp === "FIND" || this.openOp === "BUFF" || this.openOp === "EXEC" || this.openOp === "SEND" }? L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_TICK : '`' -> type(TARGET_TEXT) ;
TARGET_END : ')' { this.slotReady = true; this.metadataReady = true; } -> type(RPAREN), mode(SLOTS) ;

mode METADATA;
METADATA_FENCE : { this.closingAt(1) }? FENCE [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;
METADATA_STRING : '"' ('\\' ~[\r\n] | ~["\\\r\n])* '"' -> type(METADATA_TEXT) ;
METADATA_INNER : ~[{}"`\r\n]+ -> type(METADATA_TEXT) ;
METADATA_TICK : '`' -> type(METADATA_TEXT) ;
METADATA_QUOTE : '"' -> type(METADATA_TEXT) ;
METADATA_NEST_OPEN : '{' { this.metadataDepth++; } -> type(METADATA_TEXT) ;
METADATA_NEST_END : { this.metadataDepth > 0 }? '}' { this.metadataDepth--; } -> type(METADATA_TEXT) ;
METADATA_END : '}' { this.slotReady = true; this.metadataReady = true; } -> type(RBRACE), mode(SLOTS) ;

mode BODY;
B_END : { this.closingAfterEol() }? EOL FENCE [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_EMPTY_END : { (this.column === 0 || this.inlineBody) && this.closingAt(1) }? FENCE [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n`]+ -> type(BODY_TEXT) ;
B_TICK : '`' -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_LF : '\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_CR : '\r' -> type(BODY_TEXT) ;
