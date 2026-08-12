lexer grammar plurnkLexer;

tokens {
    LBRACKET, RBRACKET, LPAREN, RPAREN, L_MARKER, BODY_OPEN, SELF_CLOSE, COMMA,
    INT, DISPOSITION, IDENT, TAG,
    TARGET_TEXT, BODY_TEXT, CLOSE_TAG, TEXT,
    OPEN_TURN, CLOSE_TURN
}

// ============================================================================
// Lexer state — captures the open tag (OP + suffix) so subsequent modes can
// dispatch on op family for signal-type, and the body-mode close-tag predicate
// can verify the matching `<OPsuffix|>` literal.
// ============================================================================

@lexer::members {
private openTag: string = "";
private openTagLine: number = 0;
private openTagColumn: number = 0;
private bodyStart: { line: number; column: number } | null = null;
private targetDepth: number = 0;

private setOpenTag(): void {
    this.openTag = this.text.substring(2);
    // Capture where the open tag began, for reference in mismatched-close-tag errors.
    this.openTagLine = (this as any).currentTokenStartLine;
    this.openTagColumn = (this as any).currentTokenColumn;
    this.bodyStart = null;
}

public getOpenTag(): string { return this.openTag; }
public getOpenTagLine(): number { return this.openTagLine; }
public getOpenTagColumn(): number { return this.openTagColumn; }

private setBodyStart(): void {
    this.bodyStart = { line: this.line, column: this.column };
}

public getBodyStart(): { line: number; column: number } {
    if (this.bodyStart === null) throw new Error("BODY start requested before entering BODY mode");
    return this.bodyStart;
}

private atCloseTag(): boolean {
    if (this.inputStream.LA(1) !== 0x3C /* '<' */) return false;
    const tag = this.openTag;
    if (tag.length === 0) return false;
    for (let i = 0; i < tag.length; i++) {
        if (this.inputStream.LA(i + 2) !== tag.charCodeAt(i)) return false;
    }
    return this.inputStream.LA(tag.length + 2) === 0x7C /* '|' */
        && this.inputStream.LA(tag.length + 3) === 0x3E /* '>' */;
}

private isIdentChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) ||
           (c >= 0x41 && c <= 0x5A) ||
           (c >= 0x61 && c <= 0x7A) ||
           c === 0x5F;
}

private consumeRestOfCloseTagAfterLt(): void {
    // The lexer rule consumes `<` and the first tag character. Consume the
    // remaining tag characters plus the terminal `|>`.
    const remaining = this.openTag.length + 1;
    for (let i = 0; i < remaining; i++) {
        // Consume through the simulator so its line/column state advances with
        // the character stream. Direct CharStream consumption corrupts every
        // later token position by the number of skipped closer characters.
        this.interpreter.consume(this.inputStream);
    }
}

private isOpKeywordAfterLtPipe(): boolean {
    // The full minted op keyword set across all tiers — protocol (FIND…PLAN), script (TURN),
    // and client (LOOK/BUFF). Membership here means `<|KW` lexes as an opener, NOT prose, so a
    // client op in a protocol/script position becomes an OPEN_* token the parser then rejects
    // (territorial integrity: a minted op fails hard out of tier, it never masquerades as text).
    const ops = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "WORK", "FORK", "KILL", "PLAN", "TURN", "LOOK", "BUFF"];
    for (const op of ops) {
        let matches = true;
        for (let i = 0; i < op.length; i++) {
            if (this.inputStream.LA(i + 1) !== op.charCodeAt(i)) {
                matches = false;
                break;
            }
        }
        if (matches) return true;
    }
    return false;
}

private isSendOp(): boolean { return this.openTag.startsWith("SEND"); }
private isExecOp(): boolean { return this.openTag.startsWith("EXEC"); }
private isKillOp(): boolean { return this.openTag.startsWith("KILL"); }
private isTurnOp(): boolean { return this.openTag.startsWith("TURN"); }

// FIND and READ matcher bodies are single-line. A newline before the close tag
// means the closer was forgotten, so it closes the body implicitly.
private isSingleLineBodyOp(): boolean {
    return this.openTag.startsWith("FIND") || this.openTag.startsWith("READ");
}

// Implicit closes recorded for the parser to surface as recoverable errors.
private implicitCloses: Array<{ line: number, column: number, op: string }> = [];
public getImplicitCloses(): ReadonlyArray<{ line: number, column: number, op: string }> { return this.implicitCloses; }

// TURN suffix stack — one entry per open `<|TURN…>` body (pushed by the TURN body opener below,
// popped by `<TURN|>`). Stack depth doubles as nesting depth: a TURN close only fires inside
// an open TURN, so a stray `<TURN|>` at top level (or in preamble prose) stays TEXT.
private turnSuffixStack: string[] = [];

// True when the stream is at the matching `<TURN<suffix>|>` close for the innermost open TURN.
private atTurnCloseTag(): boolean {
    if (this.turnSuffixStack.length === 0) return false;
    if (this.inputStream.LA(1) !== 0x3C /* '<' */) return false;
    const tag = "TURN" + this.turnSuffixStack[this.turnSuffixStack.length - 1];
    for (let i = 0; i < tag.length; i++) {
        if (this.inputStream.LA(i + 2) !== tag.charCodeAt(i)) return false;
    }
    return this.inputStream.LA(tag.length + 2) === 0x7C /* '|' */
        && this.inputStream.LA(tag.length + 3) === 0x3E /* '>' */;
}
}

// ============================================================================
// Fragments
// ============================================================================

fragment SUFFIX    : [A-Za-z0-9_]+ ;
fragment NUM       : '-'? [0-9]+ ('.' [0-9]+)? ;
fragment L_PATTERN : '<' NUM (('-' | ',' ' '?) NUM)* '>' ;

// ============================================================================
// DEFAULT — between statements; recognize statement openers.
// ============================================================================

OPEN_FIND : '<|FIND' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_READ : '<|READ' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_EDIT : '<|EDIT' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_COPY : '<|COPY' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_MOVE : '<|MOVE' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_OPEN : '<|OPEN' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_FOLD : '<|FOLD' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_SEND : '<|SEND' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_EXEC : '<|EXEC' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
// Delegation verbs: WORK spawns a fresh named worker, FORK branches the current worker into a
// named child. Their optional single Git branch ref uses the tag-token lexer mode; the parser
// narrows that mode to exactly one TAG, while ordinary tag-bearing ops retain CSV signals.
OPEN_WORK : '<|WORK' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_FORK : '<|FORK' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_KILL : '<|KILL' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_PLAN : '<|PLAN' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
// `<|TURN…>` wraps a whole turn (Plurnk Script). Unlike every other op, its body is NOT
// opaque — it stays in statement-lexing, so the inner sandwich parses as real Plurnk.
// `<TURN|>` (below) closes it.
OPEN_TURN : '<|TURN' SUFFIX? { this.setOpenTag(); } -> type(OPEN_TURN), mode(SLOTS) ;
// Client-tier utility ops (PlurnkParser.parseClient only). Read-shaped: same SLOTS/SIGNAL_TAGS
// machinery as READ, same `<OPsuffix|>` close. The model rail never emits them (absent from the
// GBNF `OPS` set), and the protocol/script parser rules reject them — they are admitted only by
// `clientStatement`. LOOK = READ minus logging; BUFF pulls an editable entry into a buffer.
OPEN_LOOK : '<|LOOK' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_BUFF : '<|BUFF' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;

// Default-mode whitespace is hidden. Non-whitespace outside statements becomes TEXT;
// each document tier decides whether TEXT is admitted. {§whitespace-contract}
WS   : [ \t\r\n]+ -> channel(HIDDEN) ;

// Absorb a complete native reasoning enclosure as one TEXT token so an op drafted inside
// pre-PLAN reasoning cannot become the turn anchor. An unclosed enclosure falls through to
// ordinary TEXT. The stricter sampling shape is {§gbnf-turn-shape}.
THINK_BLOCK   : '<think>' .*? '</think>' -> type(TEXT) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT) ;

// `<TURN<suffix>|>` closes a TURN body — recognized in statement context (not opaque BODY mode).
// The pattern matches the FULL literal so maximal munch beats TEXT (which would otherwise eat
// The predicate (atTurnCloseTag) enforces the open TURN and exact suffix.
// Must precede TEXT.
CLOSE_TURN : { this.atTurnCloseTag() }? '<TURN' SUFFIX? '|>' { this.turnSuffixStack.pop(); } -> type(CLOSE_TURN) ;

TEXT : ('<|' { !this.isOpKeywordAfterLtPipe() }? | '<' ~[|] | ~[< \t\r\n])+ ;

// ============================================================================
// SLOTS — after open tag. Accepts any slot opener (`[`, `(`, `<scope>`) in any
// order, plus `>` to enter the body or `|>` to self-close. Signal-mode entry dispatches on op
// family so the signal slot lexes as the right token type. At-most-once-
// per-slot is enforced by the parser's permutation rules.
// ============================================================================

mode SLOTS;
SLOTS_WS       : [ \t\r\n]+ -> skip ;
SLOTS_LB_TAGS  : '[' { !this.isSendOp() && !this.isExecOp() && !this.isKillOp() }? -> type(LBRACKET), mode(SIGNAL_TAGS) ;
SLOTS_LB_INT   : '[' { this.isSendOp() || this.isKillOp() }?    -> type(LBRACKET), mode(SIGNAL_INT) ;
SLOTS_LB_IDENT : '[' { this.isExecOp() }?                       -> type(LBRACKET), mode(SIGNAL_IDENT) ;
SLOTS_LPAREN   : '(' { this.targetDepth = 0; } -> type(LPAREN), mode(TARGET) ;
SLOTS_L        : L_PATTERN -> type(L_MARKER) ;
SLOTS_SELF_CLOSE : '|>' -> type(SELF_CLOSE), mode(DEFAULT_MODE) ;
// TURN's body is internal Plurnk, not opaque — its `>` opens a turn body in statement
// mode (depth++), where the inner sandwich lexes normally; `<TURN|>` closes it. Every other
// op's `>` enters opaque BODY mode and owns its advisory scan boundary.
// {§invented-closer-advisory}
SLOTS_BODY_OPEN_TURN : { this.isTurnOp() }? '>' { this.turnSuffixStack.push(this.openTag.substring(4)); } -> type(BODY_OPEN), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : '>' { this.setBodyStart(); } -> type(BODY_OPEN), mode(BODY) ;

// ============================================================================
// SIGNAL_TAGS — inside `[...]` for FIND/READ/EDIT/COPY/MOVE/OPEN/FOLD.
// Tag character class permits single '<'; rejects '<|' so a malformed signal
// can't silently swallow a subsequent statement opener.
// ============================================================================

mode SIGNAL_TAGS;
ST_WS    : [ \t]+ -> skip ;
ST_COMMA : ',' -> type(COMMA) ;
ST_TAG   : (~[\],<\r\n \t] | '<' ~[|\],<\r\n \t])+ -> type(TAG) ;
ST_END   : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// SIGNAL_INT — inside `[...]` for SEND and KILL. Single signed integer literal
// only. `<|SEND[admin]` fails here with "expected INT".
// ============================================================================

mode SIGNAL_INT;
SI_WS   : [ \t]+ -> skip ;
// A disposition code lexes separately so a disposition-coded SEND is structurally
// terminal. KILL still admits either numeric token because its code is target-specific.
// {§send-mid-reservation} {§operation-code-polymorphism}
// Ordered before SI_INT; max-munch keeps `2000` an INT (the longer match wins).
SI_DISP : ('102' | '200' | '202' | '300' | '499') -> type(DISPOSITION) ;
SI_INT  : '-'? [0-9]+ -> type(INT) ;
SI_END  : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// SIGNAL_IDENT — inside `[...]` for EXEC. Single executor identifier only.
// `<|EXEC[1,2]` fails here.
// ============================================================================

mode SIGNAL_IDENT;
SD_WS    : [ \t]+ -> skip ;
SD_IDENT : [a-zA-Z_] [a-zA-Z0-9_.\-+]* -> type(IDENT) ;
SD_END   : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// TARGET — inside `(...)`. Content stays opaque TARGET_TEXT; AstBuilder owns
// local-vs-URL discrimination and WHATWG decomposition. {§path-syntax}
// ============================================================================

mode TARGET;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : (~[\\()<\r\n] | '<' ~[|\\()<\r\n])+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END  : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_END   : ')' -> type(RPAREN), mode(SLOTS) ;

// ============================================================================
// BODY — opaque body content. Close-tag detection via predicate matching the
// `<OPsuffix|>` literal. Matcher dialect dispatch (xpath/regex/jsonpath/glob)
// happens in AstBuilder; prefix classification is typed admission, not BNF structure.
// {§matcher-prefix-claims}
// ============================================================================

mode BODY;
// FIND and READ matcher bodies close at a newline so the AST layer receives one
// recoverable statement and can preserve the following operation boundary.
B_IMPLICIT_CLOSE : { this.isSingleLineBodyOp() }? '\n' {
    this.implicitCloses.push({ line: this.openTagLine, column: this.openTagColumn, op: this.openTag });
    this.text = '<' + this.openTag + '|>';
} -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
B_CLOSE : { this.atCloseTag() }? '<' . { this.consumeRestOfCloseTagAfterLt(); }
           -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
B_RUN   : ~[<\n]+ -> type(BODY_TEXT) ;
B_NEWLINE_MULTILINE : '\n' -> type(BODY_TEXT) ;
B_LT : '<' -> type(BODY_TEXT) ;
