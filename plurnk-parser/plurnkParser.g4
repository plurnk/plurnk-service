parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: at least one operation; outside text is hidden by the lexer.
// The host owns turn boundaries and conclusion; WAIT is the optional park request. {§turn-shape}
document
    : modelTurn EOF
    ;

// Every decision is local ({§matcher-prefix-claims}: boundaries are trustworthy). A
// disposition is recognized by its own token, never by a whole-turn alternative that a
// mid-turn error can flip onto another shape (#425 F2). {§disposition-anywhere} — dispositions
// may sit anywhere among the turn's operations, in any number; the runtime schedules them
// last, and they are one park ({§turn-disposition}).
modelTurn
    : (midStatement | dispositionStatement)+
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
    | noteStatement
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
    | noteStatement
    ;

findStatement : OPEN_FIND slotModifiers? opAside? statementEnd ;
// {§target-group} — READ and KILL take several `(path)` slots; each binds the scope and metadata after it.
readStatement : OPEN_READ targetGroup? opAside? statementEnd ;
editStatement : OPEN_EDIT slotModifiers? opAside? statementEnd ;
copyStatement : OPEN_COPY transferModifiers opAside? statementEnd ;
moveStatement : OPEN_MOVE transferModifiers opAside? statementEnd ;
// {§turn-disposition} — lifecycle operations and addressed messages are distinct.
dispositionStatement
    : OPEN_WAIT execModifiers? opAside? statementEnd
    ;
noteStatement : OPEN_NOTE opAside? statementEnd ;
sendStatement : OPEN_SEND (firstResourceSelection | metadata+)? opAside? statementEnd ;
execStatement : OPEN_EXEC execModifiers? opAside? statementEnd ;
bareStatement : OPEN_BARE targetWithMetadata? opAside? statementEnd ;
workStatement : OPEN_WORK targetWithMetadata? opAside? statementEnd ;
forkStatement : OPEN_FORK targetWithMetadata? opAside? statementEnd ;
// KILL takes a scope ({§kill-scope}): lines of a log body or of an entry.
killStatement : OPEN_KILL targetGroup? opAside? statementEnd ;
lookStatement : OPEN_LOOK slotModifiers? opAside? statementEnd ;

opAside : ASIDE ;

// Inline and multiline blocks normalize through the same AST path. A closer is
// shown, never demanded: a block also ends at the next heading or at the end of
// the input. {§empty-section} {§closer-fallback}
statementEnd
    : SECTION_END
    | BODY_OPEN body? SECTION_END?
    | body SECTION_END?
    |
    ;

// COPY and MOVE repeat the same resource selection used by single-target OPs.
// Scope and metadata belong to that operand. Neither operation admits a body: the builder
// ignores one with an advisory ({§transfer-resource-selections}).
transferModifiers
    : firstResourceSelection resourceSelection
    ;

// {§slot-order} — only the first selection can have leading metadata. Between
// targets, metadata belongs to the preceding selection, without ambiguous attachment.
firstResourceSelection
    : metadata* resourceSelection
    ;

resourceSelection
    : target selectionModifier*
    ;

selectionModifier
    : lineMarker
    | metadata
    ;

slotModifiers
    : firstResourceSelection
    | metadata* lineMarker targetWithMetadata?
    ;

// {§target-group} — each path owns its modifiers. A leading scope can only have one target.
targetGroup
    : firstResourceSelection resourceSelection*
    | metadata* lineMarker targetWithMetadata?
    ;

// The fence selects the executor; its program/tool path and metadata retain
// their own modifier slots. {§exec-executor-slot}
execModifiers
    : execSlot+
    ;
// {§exec-executor-slot} — `[{"cwd": …}]` metadata may stand without a program path on an execution.
execSlot
    : target
    | metadata
    | lineMarker
    ;

// {§log-heading-notation} — `→ path`, as the log's receipt heading shows an address, is the target.
target      : LPAREN TARGET_TEXT* lineMarker? RPAREN | ARROW_TARGET ;
targetWithMetadata : metadata* target metadata* ;
metadata    : LBRACKET METADATA_TEXT* RBRACKET ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
