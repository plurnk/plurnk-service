parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// A Plurnk packet IS a TURN. PLAN is REQUIRED — the anchor and first op, preceded only by
// free-text preamble (reasoning) — then ops with prose (comments) tolerated between them,
// closed by a REQUIRED terminal SEND. A PLAN-less or SEND-less packet does NOT parse. Prose
// surfaces as text items and is otherwise ignored. Prose tolerance stays (in Plurnk Script
// it is the comment mechanism); only PLAN was re-tightened from the 0.74.9 ingester, where
// it had been briefly optional. GBNF (model rail) already requires PLAN, so all tiers agree.
document
    : TEXT* planStatement (statement | TEXT)* sendStatement TEXT* EOF
    ;

// A bare sequence of statements — for teaching-example collections and single ops
// (PlurnkParser.parseStatements). Strict: statements only (whitespace is hidden), no prose,
// no turn shape.
statementSeq
    : statement* EOF
    ;

statement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | openStatement
    | foldStatement
    | sendStatement
    | execStatement
    | killStatement
    | planStatement
    ;

// 7 tag-CSV ops share the same modifier permutation: tagSignal, target, lineMarker
// in any order, each appearing at most once.
findStatement : OPEN_FIND tagOpModifiers? COLON body? CLOSE_TAG ;
readStatement : OPEN_READ tagOpModifiers? COLON body? CLOSE_TAG ;
editStatement : OPEN_EDIT tagOpModifiers? COLON body? CLOSE_TAG ;
copyStatement : OPEN_COPY tagOpModifiers? COLON body? CLOSE_TAG ;
moveStatement : OPEN_MOVE tagOpModifiers? COLON body? CLOSE_TAG ;
openStatement : OPEN_OPEN tagOpModifiers? COLON body? CLOSE_TAG ;
foldStatement : OPEN_FOLD tagOpModifiers? COLON body? CLOSE_TAG ;

// SEND/EXEC/KILL have no `<L>` slot. Signal and target may appear in either
// order. SEND and KILL share the int-signal modifier permutation.
sendStatement : OPEN_SEND intOpModifiers? COLON body? CLOSE_TAG ;
execStatement : OPEN_EXEC execModifiers? COLON body? CLOSE_TAG ;
killStatement : OPEN_KILL intOpModifiers? COLON body? CLOSE_TAG ;

// PLAN — reasoning recorded to the log. Canonical form is slotless; tag-op
// modifiers parse permissively (tags on thoughts are legitimate folksonomy).
planStatement : OPEN_PLAN tagOpModifiers? COLON body? CLOSE_TAG ;

// Modifier slot permutations. Each leaf rule appears at most once in any
// path through the alternatives, so duplicate slots fail at parse time.
tagOpModifiers
    : tagSignal (target lineMarker? | lineMarker target?)?
    | target (tagSignal lineMarker? | lineMarker tagSignal?)?
    | lineMarker (tagSignal target? | target tagSignal?)?
    ;

intOpModifiers
    : intSignal target?
    | target intSignal?
    ;

// EXEC's lineMarker carries an optional `<timeout,poll>` (numbers; runtime-interpreted).
execModifiers
    : identSignal (target lineMarker? | lineMarker target?)?
    | target (identSignal lineMarker? | lineMarker identSignal?)?
    | lineMarker (identSignal target? | target identSignal?)?
    ;

// Signal productions — permissive where the interpretation is deterministic.
tagSignal   : LBRACKET (TAG | COMMA)* RBRACKET ;
intSignal   : LBRACKET INT? RBRACKET ;
identSignal : LBRACKET IDENT? RBRACKET ;

target      : LPAREN TARGET_TEXT? RPAREN ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
