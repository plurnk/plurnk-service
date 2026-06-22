lexer grammar plurnkLexer;

tokens {
    LBRACKET, RBRACKET, LPAREN, RPAREN, L_MARKER, COLON, COMMA,
    INT, IDENT, TAG,
    TARGET_TEXT, BODY_TEXT, CLOSE_TAG, TEXT
}

// ============================================================================
// Lexer state — captures the open tag (OP + suffix) so subsequent modes can
// dispatch on op family for signal-type, and the body-mode close-tag predicate
// can verify the matching `:OPsuffix` literal.
// ============================================================================

@lexer::members {
private openTag: string = "";
private openTagLine: number = 0;
private openTagColumn: number = 0;

private setOpenTag(): void {
    this.openTag = this.text.substring(2);
    // Capture where the open tag began, for reference in mismatched-close-tag errors.
    this.openTagLine = (this as any).currentTokenStartLine;
    this.openTagColumn = (this as any).currentTokenColumn;
}

public getOpenTag(): string { return this.openTag; }
public getOpenTagLine(): number { return this.openTagLine; }
public getOpenTagColumn(): number { return this.openTagColumn; }

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
    const ops = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "KILL", "PLAN"];
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

OPEN_FIND : '<<FIND' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_READ : '<<READ' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_EDIT : '<<EDIT' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_COPY : '<<COPY' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_MOVE : '<<MOVE' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_OPEN : '<<OPEN' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_FOLD : '<<FOLD' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_SEND : '<<SEND' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_EXEC : '<<EXEC' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_KILL : '<<KILL' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;
OPEN_PLAN : '<<PLAN' SUFFIX? { this.setOpenTag(); } -> mode(SLOTS) ;

// Default-mode whitespace is a hidden token (not folded into TEXT) so the parser can
// require "nothing but WS" between/after ops in a turn: WS is invisible to rules, while
// any non-WS TEXT between ops makes the turn invalid.
WS   : [ \t\r\n]+ -> channel(HIDDEN) ;

// Optional in-band reasoning enclosures (when a model's reasoning is NOT channel-split
// above the grammar and lands in the text stream): absorb the WHOLE `<think>…</think>` /
// `<|channel>…<channel|>` block as one TEXT token, so a `<<PLAN` (or any op) DRAFTED while
// reasoning is not lexed as an opener and never mis-anchors the turn. Maximal munch wins
// over TEXT (which would stop at the inner `<<OP`); an UNCLOSED enclosure has no match and
// falls through to TEXT. Mirrors the GBNF optional reasoning block — keeps L(GBNF) ⊆ L(ANTLR).
THINK_BLOCK   : '<think>' .*? '</think>' -> type(TEXT) ;
CHANNEL_BLOCK : '<|channel>' .*? '<channel|>' -> type(TEXT) ;

TEXT : ('<<' { !this.isOpKeywordAfterLtLt() }? | '<' ~[<] | ~[< \t\r\n])+ ;

// ============================================================================
// SLOTS — after open tag. Accepts any slot opener (`[`, `(`, `<L>`) in any
// order, plus `:` to enter the body. Signal-mode entry dispatches on op
// family so the signal slot lexes as the right token type. At-most-once-
// per-slot is enforced by the parser's permutation rules.
// ============================================================================

mode SLOTS;
SLOTS_WS       : [ \t\r\n]+ -> skip ;
SLOTS_LB_TAGS  : '[' { !this.isSendOp() && !this.isExecOp() && !this.isKillOp() }? -> type(LBRACKET), mode(SIGNAL_TAGS) ;
SLOTS_LB_INT   : '[' { this.isSendOp() || this.isKillOp() }?    -> type(LBRACKET), mode(SIGNAL_INT) ;
SLOTS_LB_IDENT : '[' { this.isExecOp() }?                       -> type(LBRACKET), mode(SIGNAL_IDENT) ;
SLOTS_LPAREN   : '(' -> type(LPAREN), mode(TARGET) ;
SLOTS_L        : L_PATTERN -> type(L_MARKER) ;
SLOTS_COLON    : ':' -> type(COLON), mode(BODY) ;

// ============================================================================
// SIGNAL_TAGS — inside `[...]` for FIND/READ/EDIT/COPY/MOVE/OPEN/FOLD.
// Tag character class permits single '<'; rejects '<<' so a malformed signal
// can't silently swallow a subsequent statement opener.
// ============================================================================

mode SIGNAL_TAGS;
ST_WS    : [ \t]+ -> skip ;
ST_COMMA : ',' -> type(COMMA) ;
ST_TAG   : (~[\],<\r\n \t] | '<' ~[\],<\r\n \t])+ -> type(TAG) ;
ST_END   : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// SIGNAL_INT — inside `[...]` for SEND and KILL. Single signed integer literal
// only. `<<SEND[admin]` fails here with "expected INT".
// ============================================================================

mode SIGNAL_INT;
SI_WS  : [ \t]+ -> skip ;
SI_INT : '-'? [0-9]+ -> type(INT) ;
SI_END : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// SIGNAL_IDENT — inside `[...]` for EXEC. Single executor identifier only.
// `<<EXEC[1,2]` fails here.
// ============================================================================

mode SIGNAL_IDENT;
SD_WS    : [ \t]+ -> skip ;
SD_IDENT : [a-zA-Z_] [a-zA-Z0-9_.\-+]* -> type(IDENT) ;
SD_END   : ']' -> type(RBRACKET), mode(SLOTS) ;

// ============================================================================
// TARGET — inside `(...)`. Content kept as opaque TARGET_TEXT; WHATWG URL parsing
// and local-vs-URL discrimination happen in the visitor (runtime library job).
// ============================================================================

mode TARGET;
// A `#…#flags` regex target may legitimately contain `)` (regex groups). The naive
// TARGET_INNER terminates on the first `)`, so recognize a complete regex up front —
// bounded by its own `#` delimiters (`\#` escapes a literal hash). The trailing
// predicate requires the next char to be `)`, so this fires ONLY for a whole-target
// regex; a `#`-leading path that isn't a clean regex falls through to TARGET_INNER.
TARGET_REGEX : '#' ('\\' . | ~[#\r\n])* '#' [a-zA-Z]* { this.inputStream.LA(1) === 0x29 }? -> type(TARGET_TEXT) ;
TARGET_INNER : (~[)<\r\n] | '<' ~[)<\r\n])+ -> type(TARGET_TEXT) ;
TARGET_END   : ')' -> type(RPAREN), mode(SLOTS) ;

// ============================================================================
// BODY — opaque body content. Close-tag detection via predicate matching the
// `:OPsuffix` literal. Matcher dialect dispatch (xpath/regex/jsonpath/glob)
// happens in the visitor — labeling by leading character is content
// interpretation, not BNF structure.
// ============================================================================

mode BODY;
B_CLOSE : { this.atColonCloseTag() }? ':' . { this.consumeRestOfCloseTagAfterColon(); }
           -> type(CLOSE_TAG), mode(DEFAULT_MODE) ;
B_RUN   : ~[:]+ -> type(BODY_TEXT) ;
B_COLON : ':' -> type(BODY_TEXT) ;
