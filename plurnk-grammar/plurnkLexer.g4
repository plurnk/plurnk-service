lexer grammar plurnkLexer;

tokens { LBRACKET, RBRACKET, LPAREN, RPAREN, L_MARKER, COLON, SIGNAL_TEXT, PATH_TEXT, BODY_TEXT, CLOSE_TAG, TEXT }

// ============================================================================
// Lexer state — captures the open tag (OP + suffix) so the body-mode
// close-tag predicate can verify the matching `:OPsuffix` literal.
// ============================================================================

@lexer::members {
private openTag: string = "";

private setOpenTag(): void {
    this.openTag = this.text.substring(2);
}

private atColonCloseTag(): boolean {
    if (this.inputStream.LA(1) !== 0x3A /* ':' */) return false;
    const tag = this.openTag;
    if (tag.length === 0) return false;
    for (let i = 0; i < tag.length; i++) {
        if (this.inputStream.LA(i + 2) !== tag.charCodeAt(i)) return false;
    }
    const followChar = this.inputStream.LA(tag.length + 2);
    if (followChar > 0 && this.isIdentChar(followChar)) return false;
    return true;
}

private isIdentChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) ||
           (c >= 0x41 && c <= 0x5A) ||
           (c >= 0x61 && c <= 0x7A) ||
           c === 0x5F;
}

private consumeRestOfCloseTagAfterColon(): void {
    const remaining = this.openTag.length - 1;
    for (let i = 0; i < remaining; i++) {
        this.inputStream.consume();
    }
}

private isOpKeywordAfterLtLt(): boolean {
    // Called from TEXT rule after '<<' has been matched.
    // LA(1) is the first char after '<<'.
    const ops = ["FIND", "READ", "EDIT", "COPY", "MOVE", "SHOW", "HIDE", "SEND", "EXEC"];
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
}

// ============================================================================
// Fragments
// ============================================================================

fragment SUFFIX    : [A-Za-z0-9_]+ ;
fragment L_PATTERN : '<' '-'? [0-9]+ ('-' '-'? [0-9]+)? '>' ;

// ============================================================================
// DEFAULT MODE — between statements; recognize statement openers.
// ============================================================================

OPEN_FIND : '<<FIND' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_READ : '<<READ' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_EDIT : '<<EDIT' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_COPY : '<<COPY' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_MOVE : '<<MOVE' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_SHOW : '<<SHOW' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_HIDE : '<<HIDE' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_SEND : '<<SEND' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;
OPEN_EXEC : '<<EXEC' SUFFIX? { this.setOpenTag(); } -> mode(OPENED) ;

// Interstatement content: anything that isn't a recognized statement opener.
// A '<<' is part of TEXT only if the chars following aren't a valid OP keyword.
TEXT : ('<<' { !this.isOpKeywordAfterLtLt() }? | '<' ~[<] | ~[<])+ ;

// ============================================================================
// OPENED — after the open tag; allows signal, path, L, or body-`:`.
// ============================================================================

mode OPENED;
OPENED_WS       : [ \t\r\n]+ -> skip ;
OPENED_LBRACKET : '[' -> type(LBRACKET), mode(SIGNAL) ;
OPENED_LPAREN   : '(' -> type(LPAREN), mode(PATH) ;
OPENED_L        : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
OPENED_COLON    : ':' -> type(COLON), mode(BODY) ;

// ============================================================================
// POST_SIGNAL — after signal; allows path, L, or body-`:`.
// ============================================================================

mode POST_SIGNAL;
PS_WS     : [ \t\r\n]+ -> skip ;
PS_LPAREN : '(' -> type(LPAREN), mode(PATH) ;
PS_L      : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
PS_COLON  : ':' -> type(COLON), mode(BODY) ;

// ============================================================================
// POST_PATH — after path; allows L or body-`:`.
// ============================================================================

mode POST_PATH;
PP_WS    : [ \t\r\n]+ -> skip ;
PP_L     : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
PP_COLON : ':' -> type(COLON), mode(BODY) ;

// ============================================================================
// POST_L — after line marker; only body-`:` is valid.
// ============================================================================

mode POST_L;
PL_WS    : [ \t\r\n]+ -> skip ;
PL_COLON : ':' -> type(COLON), mode(BODY) ;

// ============================================================================
// SIGNAL — inside `[...]`.
// ============================================================================

mode SIGNAL;
SIGNAL_INNER : ~[\]\r\n]+ -> type(SIGNAL_TEXT) ;
SIGNAL_END   : ']' -> type(RBRACKET), mode(POST_SIGNAL) ;

// ============================================================================
// PATH — inside `(...)`.
// ============================================================================

mode PATH;
PATH_INNER : ~[)\r\n]+ -> type(PATH_TEXT) ;
PATH_END   : ')' -> type(RPAREN), mode(POST_PATH) ;

// ============================================================================
// BODY — opaque body; close-tag detection via predicate matching the
// `:OPsuffix` literal. BODY_RUN bundles runs of non-colon characters into
// single tokens for efficiency; individual `:` characters that don't begin
// a close tag are emitted as body content.
// ============================================================================

mode BODY;
BODY_CLOSE
    : { this.atColonCloseTag() }? ':' . { this.consumeRestOfCloseTagAfterColon(); }
      -> type(CLOSE_TAG), mode(DEFAULT_MODE)
    ;
BODY_RUN   : ~[:]+ -> type(BODY_TEXT) ;
BODY_COLON : ':' -> type(BODY_TEXT) ;
