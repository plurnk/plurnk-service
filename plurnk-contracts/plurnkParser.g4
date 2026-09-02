parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: optional provider/preamble TEXT and at least one operation.
// The canonical PLAN...SEND envelope remains the first alternative; model
// admission may recover either omitted envelope operation. Saved logs remain
// strict full turns. {§turn-shape}
document
    : modelTurnContent EOF
    | FENCE_OPEN modelTurn FENCE_CLOSE? EOF
    ;

// H1 PLAN is already the turn boundary, so a log is a direct sequence of turns.
log
    : turnContent+ EOF
    ;

turnContent
    : TEXT* turn
    ;

modelTurnContent
    : TEXT* modelTurn
    ;

// {§turn-shape} — PLAN is a SHOULD: a turn may open with any operation.
turn
    : planStatement? midStatement* sendStatement
    ;

// Every decision is local ({§matcher-prefix-claims}: boundaries are trustworthy). The
// terminal SEND is recognized by its own disposition signal, never by a whole-turn
// alternative that a mid-turn error can flip onto the sendless shape (#425 F2).
modelTurn
    : planStatement midStatement* sendStatement?
    | midStatement+ sendStatement?
    | sendStatement
    ;

statementSeq
    : statement* EOF
    ;

clientStatementSeq
    : clientStatement* EOF
    ;

clientStatement
    : statement
    | lookStatement
    | buffStatement
    ;

statement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | sendStatement
    | midSend
    | execStatement
    | bareStatement
    | workStatement
    | forkStatement
    | killStatement
    | planStatement
    ;

midStatement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | midSend
    | execStatement
    | bareStatement
    | workStatement
    | forkStatement
    | killStatement
    ;

findStatement : OPEN_FIND slotModifiers? opAnnotation? statementEnd ;
readStatement : OPEN_READ slotModifiers? opAnnotation? statementEnd ;
editStatement : OPEN_EDIT slotModifiers? opAnnotation? statementEnd ;
copyStatement : OPEN_COPY transferModifiers opAnnotation? emptyStatementEnd ;
moveStatement : OPEN_MOVE transferModifiers opAnnotation? emptyStatementEnd ;
// {§send-label} — a disposition label makes the SEND terminal and names no recipient; a
// mid-turn SEND messages a recipient path, or the user when it names none.
sendStatement : OPEN_SEND SEND_LABEL lineMarker? opAnnotation? statementEnd ;
midSend : OPEN_SEND targetWithMetadata? opAnnotation? statementEnd ;
execStatement : OPEN_EXEC execModifiers? opAnnotation? statementEnd ;
bareStatement : OPEN_BARE opAnnotation? statementEnd ;
workStatement : OPEN_WORK targetWithMetadata? opAnnotation? statementEnd ;
forkStatement : OPEN_FORK targetWithMetadata? opAnnotation? statementEnd ;
// KILL takes a scope ({§kill-scope}): lines of a log body or of an entry.
killStatement : OPEN_KILL slotModifiers? opAnnotation? statementEnd ;
planStatement : OPEN_PLAN slotModifiers? opAnnotation? statementEnd ;
lookStatement : OPEN_LOOK slotModifiers? opAnnotation? statementEnd ;
buffStatement : OPEN_BUFF slotModifiers? opAnnotation? statementEnd ;

opAnnotation : ANNOTATION ;

// A direct next heading, an ordinary section body, or EOF after a bodyless
// heading all normalize through the same AST path. {§empty-section}
statementEnd
    : SECTION_END
    | BODY_OPEN body? SECTION_END?
    | body SECTION_END?
    |
    ;

// COPY and MOVE are binary resource operations. Each operand owns the metadata
// and scope immediately following its target; neither operation admits a body.
transferModifiers
    : resourceSelection resourceSelection
    ;

resourceSelection
    : targetWithMetadata lineMarker?
    ;

emptyStatementEnd
    : SECTION_END
    | BODY_OPEN SECTION_END?
    |
    ;

slotModifiers
    : targetWithMetadata lineMarker?
    | lineMarker targetWithMetadata?
    ;

// EXEC names its runtime and tool in the path ({§exec-path-runtime}) and takes a scope;
// the visitor admits each slot at most once.
execModifiers
    : execSlot+
    ;
execSlot
    : targetWithMetadata
    | lineMarker
    ;

target      : LPAREN TARGET_TEXT* RPAREN ;
targetWithMetadata : target metadata* ;
metadata    : LBRACE METADATA_TEXT* RBRACE ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
