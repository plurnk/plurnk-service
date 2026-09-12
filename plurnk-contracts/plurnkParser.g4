parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: at least one operation; outside text is hidden by the lexer.
// Model admission continues silently without TASK. Concatenated saved programs
// require an explicit disposition per turn. {§turn-shape}
document
    : modelTurn EOF
    ;

// Each disposition ends one saved turn.
log
    : turn+ EOF
    ;

// {§turn-shape} — a saved turn's operations followed by its disposition (parseLog).
turn
    : midStatement* dispositionStatement
    ;

// Every decision is local ({§matcher-prefix-claims}: boundaries are trustworthy). The
// disposition is recognized by its own token, never by a whole-turn
// alternative that a mid-turn error can flip onto the sendless shape (#425 F2).
// {§disposition-anywhere} — the disposition may sit anywhere among the turn's
// operations; the runtime schedules it last.
modelTurn
    : midStatement+ (dispositionStatement midStatement*)?
    | dispositionStatement midStatement*
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
    ;

statement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | dispositionStatement
    | sendStatement
    | execStatement
    | bareStatement
    | workStatement
    | forkStatement
    | killStatement
    ;

midStatement
    : findStatement
    | readStatement
    | editStatement
    | copyStatement
    | moveStatement
    | sendStatement
    | execStatement
    | bareStatement
    | workStatement
    | forkStatement
    | killStatement
    ;

findStatement : OPEN_FIND slotModifiers? opAside? statementEnd ;
readStatement : OPEN_READ slotModifiers? opAside? statementEnd ;
editStatement : OPEN_EDIT slotModifiers? opAside? statementEnd ;
copyStatement : OPEN_COPY transferModifiers opAside? emptyStatementEnd ;
moveStatement : OPEN_MOVE transferModifiers opAside? emptyStatementEnd ;
// {§turn-disposition} — lifecycle operations and addressed messages are distinct.
dispositionStatement
    : OPEN_TASK lineMarker? opAside? statementEnd
    ;
sendStatement : OPEN_SEND resourceSelection? opAside? statementEnd ;
execStatement : OPEN_EXEC execModifiers? opAside? statementEnd ;
bareStatement : OPEN_BARE targetWithMetadata? opAside? statementEnd ;
workStatement : OPEN_WORK targetWithMetadata? opAside? statementEnd ;
forkStatement : OPEN_FORK targetWithMetadata? opAside? statementEnd ;
// KILL takes a scope ({§kill-scope}): lines of a log body or of an entry.
killStatement : OPEN_KILL slotModifiers? opAside? statementEnd ;
lookStatement : OPEN_LOOK slotModifiers? opAside? statementEnd ;

opAside : ASIDE ;

// Inline and multiline blocks normalize through the same AST path. Every
// statement retains its matching closing fence. {§empty-section}
statementEnd
    : SECTION_END
    | BODY_OPEN body? SECTION_END
    | body SECTION_END
    ;

// COPY and MOVE repeat the same resource selection used by single-target OPs.
// Scope and metadata belong to that operand; neither operation admits a body.
transferModifiers
    : resourceSelection resourceSelection
    ;

resourceSelection
    : target selectionModifier*
    ;

selectionModifier
    : lineMarker
    | metadata
    ;

emptyStatementEnd
    : SECTION_END
    | BODY_OPEN SECTION_END
    ;

slotModifiers
    : resourceSelection
    | lineMarker targetWithMetadata?
    ;

// The fence selects the executor; its program/tool path and metadata retain
// their own modifier slots. {§exec-executor-slot}
execModifiers
    : execSlot+
    ;
// {§exec-executor-slot} — `[{"cwd": …}]` metadata may stand without a program path on EXEC.
execSlot
    : targetWithMetadata
    | metadata
    | lineMarker
    ;

target      : LPAREN TARGET_TEXT* lineMarker? RPAREN ;
targetWithMetadata : target metadata* ;
metadata    : LBRACKET METADATA_TEXT* RBRACKET ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
