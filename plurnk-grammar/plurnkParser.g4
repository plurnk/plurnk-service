parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

document
    : (statement | TEXT)* EOF
    ;

statement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | showStatement
    | hideStatement
    | sendStatement
    | execStatement
    ;

// 7 tag-CSV ops share the same modifier permutation: tagSignal, path, lineMarker
// in any order, each appearing at most once.
findStatement : OPEN_FIND tagOpModifiers? COLON body? CLOSE_TAG ;
readStatement : OPEN_READ tagOpModifiers? COLON body? CLOSE_TAG ;
editStatement : OPEN_EDIT tagOpModifiers? COLON body? CLOSE_TAG ;
copyStatement : OPEN_COPY tagOpModifiers? COLON body? CLOSE_TAG ;
moveStatement : OPEN_MOVE tagOpModifiers? COLON body? CLOSE_TAG ;
showStatement : OPEN_SHOW tagOpModifiers? COLON body? CLOSE_TAG ;
hideStatement : OPEN_HIDE tagOpModifiers? COLON body? CLOSE_TAG ;

// SEND/EXEC have no `<L>` slot. Signal and path may appear in either order.
sendStatement : OPEN_SEND sendModifiers? COLON body? CLOSE_TAG ;
execStatement : OPEN_EXEC execModifiers? COLON body? CLOSE_TAG ;

// Modifier slot permutations. Each leaf rule appears at most once in any
// path through the alternatives, so duplicate slots fail at parse time.
tagOpModifiers
    : tagSignal (path lineMarker? | lineMarker path?)?
    | path (tagSignal lineMarker? | lineMarker tagSignal?)?
    | lineMarker (tagSignal path? | path tagSignal?)?
    ;

sendModifiers
    : intSignal path?
    | path intSignal?
    ;

execModifiers
    : identSignal path?
    | path identSignal?
    ;

// Signal productions — permissive where the interpretation is deterministic.
tagSignal   : LBRACKET (TAG | COMMA)* RBRACKET ;
intSignal   : LBRACKET INT? RBRACKET ;
identSignal : LBRACKET IDENT? RBRACKET ;

path        : LPAREN PATH_TEXT? RPAREN ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
