lexer grammar plurnkLexer;

tokens { LBRACKET, RBRACKET, LPAREN, RPAREN, L_MARKER, SIGNAL_TEXT, PATH_TEXT, BODY_TEXT, CLOSE_TAG }

// ============================================================================
// Lexer state — captures the open tag (OP + suffix) so the body-mode
// close-tag predicate can verify the matching literal.
// ============================================================================

@lexer::members {
private openTag: string = "";

private setOpenTag(): void {
    this.openTag = this.text.substring(2);
}

private atCloseTag(): boolean {
    const tag = this.openTag;
    if (tag.length === 0) return false;
    for (let i = 0; i < tag.length; i++) {
        if (this.inputStream.LA(i + 1) !== tag.charCodeAt(i)) return false;
    }
    const followChar = this.inputStream.LA(tag.length + 1);
    if (followChar > 0 && this.isIdentChar(followChar)) return false;
    return true;
}

private isIdentChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) ||
           (c >= 0x41 && c <= 0x5A) ||
           (c >= 0x61 && c <= 0x7A) ||
           c === 0x5F;
}

private consumeRestOfCloseTag(): void {
    const remaining = this.openTag.length - 1;
    for (let i = 0; i < remaining; i++) {
        this.inputStream.consume();
    }
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

WS : [ \t\r\n]+ -> skip ;

// ============================================================================
// OPENED — after the open tag; allows signal, path, L, or body.
// ============================================================================

mode OPENED;
OPENED_WS       : [ \t\r\n]+ -> skip ;
OPENED_LBRACKET : '[' -> type(LBRACKET), mode(SIGNAL) ;
OPENED_LPAREN   : '(' -> type(LPAREN), mode(PATH) ;
OPENED_L        : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
OPENED_CLOSE    : { this.atCloseTag() }? . { this.consumeRestOfCloseTag(); } -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
OPENED_BODY     : . -> more, mode(BODY) ;

// ============================================================================
// POST_SIGNAL — after signal; allows path, L, or body. No more signal.
// ============================================================================

mode POST_SIGNAL;
PS_WS     : [ \t\r\n]+ -> skip ;
PS_LPAREN : '(' -> type(LPAREN), mode(PATH) ;
PS_L      : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
PS_CLOSE  : { this.atCloseTag() }? . { this.consumeRestOfCloseTag(); } -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
PS_BODY   : . -> more, mode(BODY) ;

// ============================================================================
// POST_PATH — after path; allows L or body. No more signal or path.
// ============================================================================

mode POST_PATH;
PP_WS    : [ \t\r\n]+ -> skip ;
PP_L     : L_PATTERN -> type(L_MARKER), mode(POST_L) ;
PP_CLOSE : { this.atCloseTag() }? . { this.consumeRestOfCloseTag(); } -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
PP_BODY  : . -> more, mode(BODY) ;

// ============================================================================
// POST_L — after line marker; body only.
// ============================================================================

mode POST_L;
PL_WS    : [ \t\r\n]+ -> skip ;
PL_CLOSE : { this.atCloseTag() }? . { this.consumeRestOfCloseTag(); } -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
PL_BODY  : . -> more, mode(BODY) ;

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
// BODY — opaque body; close-tag detection via predicate against captured
// open tag. BODY_RUN bundles runs of non-uppercase characters into single
// tokens; each uppercase character is checked individually as a potential
// close-tag start.
// ============================================================================

mode BODY;
BODY_CLOSE : { this.atCloseTag() }? . { this.consumeRestOfCloseTag(); } -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
BODY_RUN   : ~[A-Z]+ -> type(BODY_TEXT) ;
BODY_CHAR  : . -> type(BODY_TEXT) ;
