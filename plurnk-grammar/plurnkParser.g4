parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// A Plurnk packet IS a TURN (PlurnkParser.parse). The sandwich is law: exactly one
// PLAN-anchored turn — PLAN first (only free-text preamble precedes it), mid-ops with prose
// (comments) between, a REQUIRED terminal SEND, EOF. NO mid-op PLAN (a second PLAN would
// start a new turn — use parseLog for that). PLAN-less / SEND-less / multi-turn input does
// NOT parse. Prose surfaces as text items. GBNF already enforces PLAN-first, so all tiers agree.
document
    : turnContent EOF
    ;

// A multi-turn LOG (PlurnkParser.parseLog) — the Plurnk Script substrate. Each turn is a full
// sandwich WRAPPED in `<<TURN…: … :TURN`. A log is valid iff every wrapped turn is valid.
// `parse()` stays the bare unwrapped sandwich; parseLog is the wrapped, multi-turn path.
log
    : turnStatement+ EOF
    ;

// `<<TURN[label]?(target)?<L>?: <a full turn> :TURN` — wraps one sandwich. Modifiers parse
// but are semantically undefined in v1. The body is `turnContent` (real, internal Plurnk).
turnStatement
    : OPEN_TURN tagOpModifiers? COLON turnContent CLOSE_TURN
    ;

// One turn, shared by `document` and `log`. PLAN required and FIRST (only free-text preamble
// precedes); mid-ops are `midStatement` (every op EXCEPT PLAN — that is what makes PLAN the
// turn boundary) with prose tolerated; terminal SEND required.
turnContent
    : TEXT* planStatement (midStatement | TEXT)* sendStatement TEXT*
    ;

// A bare sequence of statements — for teaching-example collections and single ops
// (PlurnkParser.parseStatements). Strict: statements only (whitespace is hidden), no prose,
// no turn shape.
statementSeq
    : statement* EOF
    ;

// The CLIENT tier (PlurnkParser.parseClient) — the topmost subset, one above Script. A bare
// sequence (like statementSeq) of either a protocol `statement` OR a client-only utility op
// (LOOK / BUFF). The client ops are admitted HERE ONLY; `document`, `log`, and `statementSeq`
// never reach `lookStatement`/`buffStatement`, so a client op in protocol/script position is a
// parse error. LOOK/BUFF are transient client commands, not model turns — hence flat, no turn
// shape and no PLAN anchor.
clientStatementSeq
    : clientStatement* EOF
    ;

clientStatement
    : statement
    | lookStatement
    | buffStatement
    ;

// Full op set, incl PLAN — used by statementSeq (single ops / teaching corpora). Flat:
// directly wraps each op-statement (AstBuilder dispatches on the child type).
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

// Every op EXCEPT PLAN — `statement` minus `planStatement`. PLAN is the turn anchor, never a
// mid-op, so excluding it here makes a fresh `<<PLAN` begin the next turn rather than sit
// mid-batch. Parallel flat rule (same op-statement accessors as `statement`, no planStatement).
midStatement
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
    ;

// 7 tag-CSV ops share the same modifier permutation: tagSignal, target, lineMarker
// in any order, each appearing at most once.
findStatement : OPEN_FIND tagOpModifiers? COLON? body? CLOSE_TAG ;
readStatement : OPEN_READ tagOpModifiers? COLON? body? CLOSE_TAG ;
editStatement : OPEN_EDIT tagOpModifiers? COLON? body? CLOSE_TAG ;
copyStatement : OPEN_COPY tagOpModifiers? COLON? body? CLOSE_TAG ;
moveStatement : OPEN_MOVE tagOpModifiers? COLON? body? CLOSE_TAG ;
openStatement : OPEN_OPEN tagOpModifiers? COLON? body? CLOSE_TAG ;
foldStatement : OPEN_FOLD tagOpModifiers? COLON? body? CLOSE_TAG ;

// SEND/EXEC/KILL have no `<L>` slot. Signal and target may appear in either
// order. SEND and KILL share the int-signal modifier permutation.
sendStatement : OPEN_SEND intOpModifiers? COLON? body? CLOSE_TAG ;
execStatement : OPEN_EXEC execModifiers? COLON? body? CLOSE_TAG ;
killStatement : OPEN_KILL intOpModifiers? COLON? body? CLOSE_TAG ;

// PLAN — reasoning recorded to the log. Canonical form is slotless; tag-op
// modifiers parse permissively (tags on thoughts are legitimate folksonomy).
planStatement : OPEN_PLAN tagOpModifiers? COLON? body? CLOSE_TAG ;

// LOOK / BUFF — client-tier utility ops, read-shaped (identical signature to readStatement:
// tag-CSV + target + lineMarker permutation, matcher body). LOOK is READ minus logging; BUFF
// pulls an editable entry into a buffer (the write-back is a later plain EDIT, not part of BUFF).
lookStatement : OPEN_LOOK tagOpModifiers? COLON? body? CLOSE_TAG ;
buffStatement : OPEN_BUFF tagOpModifiers? COLON? body? CLOSE_TAG ;

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
