lexer grammar plurnkLexer;

tokens {
    LPAREN, RPAREN, LBRACE, RBRACE, L_MARKER, COMBINED_L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ANNOTATION, SEND_LABEL, EXECUTOR
}

@lexer::members {
private activeDelimiter: string | null = null;
private openOp: string = "";
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private slotReady: boolean = false;
private targetDepth: number = 0;
private metadataDepth: number = 0;
private metadataReady: boolean = false;
private bodyAtStart: boolean = false;
private terminalSend: boolean = false;
private documentFence: boolean = false;

private static readonly PROTOCOL_OPS = [
    "FIND", "READ", "EDIT", "COPY", "MOVE",
    "SEND", "EXEC", "BARE", "WORK", "FORK", "KILL",
];
private static readonly CLIENT_OPS = ["LOOK", "BUFF"];

    private isDelimiterChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39)
        || (c >= 0x41 && c <= 0x5A)
        || (c >= 0x61 && c <= 0x7A)
        || c === 0x5F;
}

private matchesLiteral(offset: number, literal: string): boolean {
    for (let i = 0; i < literal.length; i++) {
        if (this.inputStream.LA(offset + i) !== literal.charCodeAt(i)) return false;
    }
    return true;
}

    private headingAt(offset: number): { level: 1 | 2; op: string; delimiter: string } | null {
    let level: 1 | 2;
    let cursor = offset;
    if (this.matchesLiteral(cursor, "## PLAN")) {
        level = 1;
        cursor += "## PLAN".length;
    } else if (this.matchesLiteral(cursor, "### ")) {
        level = 2;
        cursor += 4;
    } else {
        return null;
    }

    let op = "PLAN";
    if (level === 2) {
        const operations = [...plurnkLexer.PROTOCOL_OPS, ...plurnkLexer.CLIENT_OPS];
        op = operations.find((candidate) => this.matchesLiteral(cursor, candidate)) ?? "";
        if (op.length === 0) return null;
        cursor += op.length;
    }

    let delimiter = "";
    while (this.isDelimiterChar(this.inputStream.LA(cursor))) {
        delimiter += String.fromCharCode(this.inputStream.LA(cursor));
        cursor++;
    }
    const next = this.inputStream.LA(cursor);
    const headerContinues = next <= 0
        || next === 0x20 || next === 0x09
        || next === 0x5B || next === 0x28 || next === 0x7B || next === 0x3C
        || next === 0x0A || next === 0x0D;
    if (!headerContinues) return null;
    const startsNextTurn = this.terminalSend;
    if (this.activeDelimiter !== null && delimiter !== this.activeDelimiter && !startsNextTurn) return null;
    return { level, op, delimiter };
}

private matchesHeading(level: 1 | 2, op: string): boolean {
    // The initial PLAN terminates tolerated provider preamble text, even when
    // the provider omitted a separating newline. Once PLAN establishes the
    // lane, every heading retains the ordinary column-zero boundary.
    const initialPlan = level === 1 && op === "PLAN" && this.activeDelimiter === null;
    if (this.column !== 0 && !initialPlan) return false;
    const heading = this.headingAt(1);
    return heading !== null && heading.level === level && heading.op === op;
}

private open(level: 1 | 2, op: string): void {
    const prefixLength = (level === 1 ? "## " : "### ").length + op.length;
    const delimiter = this.text.slice(prefixLength);
    const startsNextTurn = this.terminalSend;
    if (this.activeDelimiter === null || startsNextTurn) this.activeDelimiter = delimiter;
    this.openOp = op;
    this.openHeading = this.text;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.slotReady = true;
    // {§exec-executor-slot} — an EXEC heading admits `{cwd=…}` before any path; elsewhere metadata follows a target.
    this.metadataReady = op === "EXEC";
    this.bodyAtStart = false;
    this.terminalSend = false;
}

private offsetAfterEol(offset: number): number | null {
    if (this.inputStream.LA(offset) === 0x0D && this.inputStream.LA(offset + 1) === 0x0A) return offset + 2;
    if (this.inputStream.LA(offset) === 0x0A) return offset + 1;
    return null;
}

private headingAfterDirectEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.headingAt(after) !== null;
}

private headingAfterBlankLine(): boolean {
    let after = this.offsetAfterEol(1);
    if (after === null) return false;
    while (this.inputStream.LA(after) === 0x20 || this.inputStream.LA(after) === 0x09) after++;
    after = this.offsetAfterEol(after);
    return after !== null && this.headingAt(after) !== null;
}

private headingAfterEmptySpacedLine(): boolean {
    if (!this.bodyAtStart) return false;
    let after = 1;
    while (this.inputStream.LA(after) === 0x20 || this.inputStream.LA(after) === 0x09) after++;
    const lineEnd = this.offsetAfterEol(after);
    return lineEnd !== null && this.headingAt(lineEnd) !== null;
}

private beginBody(): void { this.bodyAtStart = true; }
private retainBody(): void { this.bodyAtStart = false; }
// {§heading-inline-body} — body text on the heading line is tolerated AND announced: the
// parser turns each note into one warning-severity advisory after the statement.
private inlineBodies: Array<{ line: number; column: number; heading: string }> = [];
private noteInlineBody(): void {
    this.inlineBodies.push({ line: this.getOpenTagLine(), column: this.getOpenTagColumn(), heading: this.getOpenHeading() });
}
public takeInlineBodies(): Array<{ line: number; column: number; heading: string }> {
    const taken = this.inlineBodies;
    this.inlineBodies = [];
    return taken;
}

private openDocumentFence(): void { this.documentFence = true; }
private closeDocumentFence(): void { this.documentFence = false; }
private inDocumentFence(): boolean { return this.documentFence; }
private fenceAfterDirectEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.matchesLiteral(after, "```");
}

public getOpenTag(): string { return this.openOp + (this.activeDelimiter ?? ""); }
public getOpenTagLine(): number { return this.openHeadingLine; }
public getOpenTagColumn(): number { return this.openHeadingColumn; }
public getOpenHeading(): string { return this.openHeading; }

// {§kill-scope} — KILL scopes lines of a log body or an entry, so it takes anchors like EDIT.
private isTextCoordinateOp(): boolean {
    return this.openOp === "READ" || this.openOp === "EDIT" || this.openOp === "COPY" || this.openOp === "MOVE"
        || this.openOp === "KILL" || this.openOp === "LOOK";
}
private inlineBodyAhead(): boolean {
    const previous = this.inputStream.LA(-1);
    return previous === 0x20 || previous === 0x09;
}
}

fragment DELIMITER    : [A-Za-z0-9_]+ ;
fragment NUM       : '-'? [0-9]+ ('.' [0-9]+)? ;
fragment L_PATTERN : '<' NUM (('-' | ',' ' '?) NUM)* '>' ;
fragment LINE_ANCHOR : '@' [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] ;
fragment TEXT_COORD  : NUM | LINE_ANCHOR ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment COMBINED_LINE_COORD : LINE_ANCHOR (':' | ' ') [1-9] [0-9]* ;
fragment COMBINED_TEXT_COORD : TEXT_COORD | COMBINED_LINE_COORD ;
fragment COMBINED_TEXT_L_PATTERN : '<' COMBINED_TEXT_COORD (',' ' '? COMBINED_TEXT_COORD)* '>' ;
fragment EOL       : '\r'? '\n' ;

// PLAN alone is H2. Protocol and client operations are H3. The first heading
// establishes the lane; later rules fire only for the exact same delimiter.
OPEN_PLAN : { this.matchesHeading(1, "PLAN") }? '## PLAN' DELIMITER? { this.open(1, "PLAN"); } -> mode(SLOTS) ;
OPEN_FIND : { this.matchesHeading(2, "FIND") }? '### FIND' DELIMITER? { this.open(2, "FIND"); } -> mode(SLOTS) ;
OPEN_READ : { this.matchesHeading(2, "READ") }? '### READ' DELIMITER? { this.open(2, "READ"); } -> mode(SLOTS) ;
OPEN_EDIT : { this.matchesHeading(2, "EDIT") }? '### EDIT' DELIMITER? { this.open(2, "EDIT"); } -> mode(SLOTS) ;
OPEN_COPY : { this.matchesHeading(2, "COPY") }? '### COPY' DELIMITER? { this.open(2, "COPY"); } -> mode(SLOTS) ;
OPEN_MOVE : { this.matchesHeading(2, "MOVE") }? '### MOVE' DELIMITER? { this.open(2, "MOVE"); } -> mode(SLOTS) ;
OPEN_SEND : { this.matchesHeading(2, "SEND") }? '### SEND' DELIMITER? { this.open(2, "SEND"); } -> mode(SLOTS) ;
OPEN_EXEC : { this.matchesHeading(2, "EXEC") }? '### EXEC' DELIMITER? { this.open(2, "EXEC"); } -> mode(SLOTS) ;
OPEN_BARE : { this.matchesHeading(2, "BARE") }? '### BARE' DELIMITER? { this.open(2, "BARE"); } -> mode(SLOTS) ;
OPEN_WORK : { this.matchesHeading(2, "WORK") }? '### WORK' DELIMITER? { this.open(2, "WORK"); } -> mode(SLOTS) ;
OPEN_FORK : { this.matchesHeading(2, "FORK") }? '### FORK' DELIMITER? { this.open(2, "FORK"); } -> mode(SLOTS) ;
OPEN_KILL : { this.matchesHeading(2, "KILL") }? '### KILL' DELIMITER? { this.open(2, "KILL"); } -> mode(SLOTS) ;
OPEN_LOOK : { this.matchesHeading(2, "LOOK") }? '### LOOK' DELIMITER? { this.open(2, "LOOK"); } -> mode(SLOTS) ;
OPEN_BUFF : { this.matchesHeading(2, "BUFF") }? '### BUFF' DELIMITER? { this.open(2, "BUFF"); } -> mode(SLOTS) ;

FENCE_OPEN : { this.column === 0 && !this.inDocumentFence() }? ('```example' | '```plurnk') EOL { this.openDocumentFence(); } ;
FENCE_CLOSE : { this.column === 0 && this.inDocumentFence() }? '```' EOL? { this.closeDocumentFence(); } ;

WS : [ \t\r\n]+ -> channel(HIDDEN) ;
THINK_BLOCK   : '<think>' .*? '</think>' -> type(TEXT) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT) ;
// Keep `#` at a token boundary so a separator-free initial PLAN can terminate
// ordinary provider preamble instead of being swallowed by greedy TEXT.
TEXT : ~[ \t\r\n#]+ ;
TEXT_HASH : '#' -> type(TEXT) ;

mode SLOTS;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
// {§send-label} — `(NEXT|WAIT|TERM|FAIL)` on a SEND is one token: the turn's terminal label.
SLOTS_SEND_LABEL : { this.slotReady && this.openOp === "SEND" }? '(' ('NEXT' | 'WAIT' | 'TERM' | 'FAIL') ')' { this.terminalSend = true; this.slotReady = true; this.metadataReady = false; } -> type(SEND_LABEL) ;
// {§exec-executor-slot} — `[executor]` on an EXEC heading is one token: the registered executor that runs the program.
SLOTS_EXECUTOR : { this.slotReady && this.openOp === "EXEC" }? '[' [A-Za-z0-9_.+-]+ ']' { this.slotReady = true; this.metadataReady = true; } -> type(EXECUTOR) ;
SLOTS_LPAREN   : { this.slotReady }? '(' { this.targetDepth = 0; this.metadataReady = false; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACE   : { this.slotReady && this.metadataReady }? '{' { this.metadataDepth = 0; } -> type(LBRACE), mode(METADATA) ;
SLOTS_TEXT_L   : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L        : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(COMBINED_L_MARKER) ;
SLOTS_ANNOTATION : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ANNOTATION) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<] { this.noteInlineBody(); this.retainBody(); } -> type(BODY_TEXT), mode(BODY) ;
SLOTS_DIRECT_END : { this.headingAfterDirectEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : EOL { this.beginBody(); } -> type(BODY_OPEN), mode(BODY) ;

mode TARGET;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END  : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_END   : ')' { this.slotReady = true; this.metadataReady = true; } -> type(RPAREN), mode(SLOTS) ;

mode METADATA;
METADATA_INNER : ~[{}\r\n]+ -> type(METADATA_TEXT) ;
METADATA_NEST_OPEN : '{' { this.metadataDepth++; } -> type(METADATA_TEXT) ;
METADATA_NEST_END : { this.metadataDepth > 0 }? '}' { this.metadataDepth--; } -> type(METADATA_TEXT) ;
METADATA_END : '}' { this.slotReady = true; this.metadataReady = true; } -> type(RBRACE), mode(SLOTS) ;

mode BODY;
B_FENCE_CLOSE : { this.column === 0 && this.inDocumentFence() }? '```' EOL? { this.closeDocumentFence(); } -> type(FENCE_CLOSE), mode(DEFAULT_MODE) ;
B_FENCE_END : { this.inDocumentFence() && this.fenceAfterDirectEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_SECTION_END : { this.headingAfterBlankLine() }? EOL [ \t]* EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_DIRECT_END : { this.headingAfterDirectEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_EMPTY_SPACED_END : { this.headingAfterEmptySpacedLine() }? [ \t]+ EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n]+ { this.retainBody(); } -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.retainBody(); } -> type(BODY_TEXT) ;
B_LF : '\n' { this.retainBody(); } -> type(BODY_TEXT) ;
B_CR : '\r' { this.retainBody(); } -> type(BODY_TEXT) ;
