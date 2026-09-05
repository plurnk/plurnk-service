parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: optional provider/preamble TEXT and at least one operation.
// Model admission may recover an omitted disposition. Saved logs require one
// disposition per turn. Authored position does not prescribe execution order. {§turn-shape}
document
    : modelTurnContent EOF
    | FENCE_OPEN modelTurn FENCE_CLOSE? EOF
    ;

// PLAN separates saved turns; a disposition need not be their last statement.
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
    : planStatement? midStatement* sendStatement midStatement*
    ;

// Every decision is local ({§matcher-prefix-claims}: boundaries are trustworthy). The
// disposition SEND is recognized by its own label, never by a whole-turn
// alternative that a mid-turn error can flip onto the sendless shape (#425 F2).
modelTurn
    : planStatement midStatement* (sendStatement midStatement*)?
    | midStatement+ (sendStatement midStatement*)?
    | sendStatement midStatement*
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
execStatement : OPEN_EXEC EXECUTOR? execModifiers? EXECUTOR? opAnnotation? statementEnd ;
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

// EXEC names its runtime and tool in the path ({§exec-executor-slot}) and takes a scope;
// the visitor admits each slot at most once.
execModifiers
    : execSlot+
    ;
// {§exec-executor-slot} — `{cwd=…}` metadata may stand without a program path on EXEC.
execSlot
    : targetWithMetadata
    | metadata
    | lineMarker
    ;

target      : LPAREN TARGET_TEXT* RPAREN ;
targetWithMetadata : target metadata* ;
metadata    : LBRACE METADATA_TEXT* RBRACE ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
