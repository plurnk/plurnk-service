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

// {§turn-shape} — turns contain ordinary operations followed by a disposition.
turn
    : midStatement* dispositionStatement
    ;

// Every decision is local ({§matcher-prefix-claims}: boundaries are trustworthy). The
// disposition is recognized by its own token, never by a whole-turn
// alternative that a mid-turn error can flip onto the sendless shape (#425 F2).
// Statements after the disposition stay recognizable here so that model admission
// can drop them and name what it dropped ({§disposition-ends-turn}).
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
    | buffStatement
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

findStatement : OPEN_FIND slotModifiers? opAnnotation? statementEnd ;
readStatement : OPEN_READ slotModifiers? opAnnotation? statementEnd ;
editStatement : OPEN_EDIT slotModifiers? opAnnotation? statementEnd ;
copyStatement : OPEN_COPY transferModifiers opAnnotation? emptyStatementEnd ;
moveStatement : OPEN_MOVE transferModifiers opAnnotation? emptyStatementEnd ;
// {§turn-disposition} — lifecycle operations and addressed messages are distinct.
dispositionStatement
    : OPEN_TASK lineMarker? opAnnotation? statementEnd
    ;
sendStatement : OPEN_SEND resourceSelection? opAnnotation? statementEnd ;
execStatement : OPEN_EXEC execModifiers? opAnnotation? statementEnd ;
bareStatement : OPEN_BARE targetWithMetadata? opAnnotation? statementEnd ;
workStatement : OPEN_WORK targetWithMetadata? opAnnotation? statementEnd ;
forkStatement : OPEN_FORK targetWithMetadata? opAnnotation? statementEnd ;
// KILL takes a scope ({§kill-scope}): lines of a log body or of an entry.
killStatement : OPEN_KILL slotModifiers? opAnnotation? statementEnd ;
lookStatement : OPEN_LOOK slotModifiers? opAnnotation? statementEnd ;
buffStatement : OPEN_BUFF slotModifiers? opAnnotation? statementEnd ;

opAnnotation : ANNOTATION ;

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
