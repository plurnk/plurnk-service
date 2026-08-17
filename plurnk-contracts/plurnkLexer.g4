lexer grammar plurnkLexer;

tokens {
    LBRACKET, RBRACKET, LPAREN, RPAREN, L_MARKER, COMBINED_L_MARKER, BODY_OPEN, SECTION_END, COMMA,
    INT, DISPOSITION, IDENT, TAG,
    TARGET_TEXT, BODY_TEXT, TEXT, ANNOTATION
}

@lexer::members {
private activeDelimiter: string | null = null;
private openOp: string = "";
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private slotReady: boolean = false;
private targetDepth: number = 0;
private bodyAtStart: boolean = false;
private terminalSend: boolean = false;
private documentFence: boolean = false;

private static readonly PROTOCOL_OPS = [
    "FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD",
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
    if (this.matchesLiteral(cursor, "# PLAN")) {
        level = 1;
        cursor += "# PLAN".length;
    } else if (this.matchesLiteral(cursor, "## ")) {
        level = 2;
        cursor += 3;
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
        || next === 0x5B || next === 0x28 || next === 0x3C
        || next === 0x0A || next === 0x0D;
    if (!headerContinues) return null;
    const startsNextTurn = level === 1 && op === "PLAN" && this.terminalSend;
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
    const prefixLength = (level === 1 ? "# " : "## ").length + op.length;
    const delimiter = this.text.slice(prefixLength);
    const startsNextTurn = level === 1 && op === "PLAN" && this.terminalSend;
    if (this.activeDelimiter === null || startsNextTurn) this.activeDelimiter = delimiter;
    this.openOp = op;
    this.openHeading = this.text;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.slotReady = true;
    this.bodyAtStart = false;
    this.terminalSend = false;
}

private markDisposition(): void {
    if (this.openOp === "SEND") this.terminalSend = true;
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

private isSendOp(): boolean { return this.openOp === "SEND"; }
private isExecOp(): boolean { return this.openOp === "EXEC"; }
private isTextCoordinateOp(): boolean {
    return this.openOp === "READ" || this.openOp === "EDIT" || this.openOp === "COPY" || this.openOp === "MOVE" || this.openOp === "LOOK";
}
private isKillOp(): boolean { return this.openOp === "KILL"; }
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

// PLAN alone is H1. Protocol and client operations are H2. The first heading
// establishes the lane; later rules fire only for the exact same delimiter.
OPEN_PLAN : { this.matchesHeading(1, "PLAN") }? '# PLAN' DELIMITER? { this.open(1, "PLAN"); } -> mode(SLOTS) ;
OPEN_FIND : { this.matchesHeading(2, "FIND") }? '## FIND' DELIMITER? { this.open(2, "FIND"); } -> mode(SLOTS) ;
OPEN_READ : { this.matchesHeading(2, "READ") }? '## READ' DELIMITER? { this.open(2, "READ"); } -> mode(SLOTS) ;
OPEN_EDIT : { this.matchesHeading(2, "EDIT") }? '## EDIT' DELIMITER? { this.open(2, "EDIT"); } -> mode(SLOTS) ;
OPEN_COPY : { this.matchesHeading(2, "COPY") }? '## COPY' DELIMITER? { this.open(2, "COPY"); } -> mode(SLOTS) ;
OPEN_MOVE : { this.matchesHeading(2, "MOVE") }? '## MOVE' DELIMITER? { this.open(2, "MOVE"); } -> mode(SLOTS) ;
OPEN_OPEN : { this.matchesHeading(2, "OPEN") }? '## OPEN' DELIMITER? { this.open(2, "OPEN"); } -> mode(SLOTS) ;
OPEN_FOLD : { this.matchesHeading(2, "FOLD") }? '## FOLD' DELIMITER? { this.open(2, "FOLD"); } -> mode(SLOTS) ;
OPEN_SEND : { this.matchesHeading(2, "SEND") }? '## SEND' DELIMITER? { this.open(2, "SEND"); } -> mode(SLOTS) ;
OPEN_EXEC : { this.matchesHeading(2, "EXEC") }? '## EXEC' DELIMITER? { this.open(2, "EXEC"); } -> mode(SLOTS) ;
OPEN_BARE : { this.matchesHeading(2, "BARE") }? '## BARE' DELIMITER? { this.open(2, "BARE"); } -> mode(SLOTS) ;
OPEN_WORK : { this.matchesHeading(2, "WORK") }? '## WORK' DELIMITER? { this.open(2, "WORK"); } -> mode(SLOTS) ;
OPEN_FORK : { this.matchesHeading(2, "FORK") }? '## FORK' DELIMITER? { this.open(2, "FORK"); } -> mode(SLOTS) ;
OPEN_KILL : { this.matchesHeading(2, "KILL") }? '## KILL' DELIMITER? { this.open(2, "KILL"); } -> mode(SLOTS) ;
OPEN_LOOK : { this.matchesHeading(2, "LOOK") }? '## LOOK' DELIMITER? { this.open(2, "LOOK"); } -> mode(SLOTS) ;
OPEN_BUFF : { this.matchesHeading(2, "BUFF") }? '## BUFF' DELIMITER? { this.open(2, "BUFF"); } -> mode(SLOTS) ;

FENCE_OPEN : { this.column === 0 && !this.inDocumentFence() }? '```plurnk' EOL { this.openDocumentFence(); } ;
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
SLOTS_LB_TAGS  : { this.slotReady && !this.isSendOp() && !this.isExecOp() && !this.isKillOp() }? '[' -> type(LBRACKET), mode(SIGNAL_TAGS) ;
SLOTS_LB_INT   : { this.slotReady && (this.isSendOp() || this.isKillOp()) }? '[' -> type(LBRACKET), mode(SIGNAL_INT) ;
SLOTS_LB_IDENT : { this.slotReady && this.isExecOp() }? '[' -> type(LBRACKET), mode(SIGNAL_IDENT) ;
SLOTS_LPAREN   : { this.slotReady }? '(' { this.targetDepth = 0; } -> type(LPAREN), mode(TARGET) ;
SLOTS_TEXT_L   : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L        : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(COMBINED_L_MARKER) ;
SLOTS_ANNOTATION : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ANNOTATION) ;
SLOTS_DIRECT_END : { this.headingAfterDirectEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : EOL { this.beginBody(); } -> type(BODY_OPEN), mode(BODY) ;

mode SIGNAL_TAGS;
ST_WS    : [ \t]+ -> skip ;
ST_COMMA : ',' -> type(COMMA) ;
ST_TAG   : ~[\],\r\n \t]+ -> type(TAG) ;
ST_END   : ']' { this.slotReady = true; } -> type(RBRACKET), mode(SLOTS) ;

mode SIGNAL_INT;
SI_WS   : [ \t]+ -> skip ;
SI_DISP : ('102' | '200' | '202' | '300' | '499') { this.markDisposition(); } -> type(DISPOSITION) ;
SI_INT  : '-'? [0-9]+ -> type(INT) ;
SI_END  : ']' { this.slotReady = true; } -> type(RBRACKET), mode(SLOTS) ;

mode SIGNAL_IDENT;
SD_WS    : [ \t]+ -> skip ;
SD_IDENT : [a-zA-Z_] [a-zA-Z0-9_.\-+]* -> type(IDENT) ;
SD_END   : ']' { this.slotReady = true; } -> type(RBRACKET), mode(SLOTS) ;

mode TARGET;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END  : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_END   : ')' { this.slotReady = true; } -> type(RPAREN), mode(SLOTS) ;

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
