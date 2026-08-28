parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: optional provider/preamble TEXT, H1 PLAN, zero or more H2
// operations, and one disposition-coded terminal H2 SEND. {§turn-shape}
document
    : turnContent EOF
    | FENCE_OPEN turn FENCE_CLOSE? EOF
    ;

// H1 PLAN is already the turn boundary, so a log is a direct sequence of turns.
log
    : turnContent+ EOF
    ;

turnContent
    : TEXT* turn
    ;

turn
    : planStatement midStatement* sendStatement
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
    | openStatement
    | foldStatement
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
    | openStatement
    | foldStatement
    | midSend
    | execStatement
    | bareStatement
    | workStatement
    | forkStatement
    | killStatement
    ;

findStatement : OPEN_FIND tagOpModifiers? opAnnotation? statementEnd ;
readStatement : OPEN_READ tagOpModifiers? opAnnotation? statementEnd ;
editStatement : OPEN_EDIT tagOpModifiers? opAnnotation? statementEnd ;
copyStatement : OPEN_COPY transferModifiers opAnnotation? emptyStatementEnd ;
moveStatement : OPEN_MOVE transferModifiers opAnnotation? emptyStatementEnd ;
openStatement : OPEN_OPEN tagOpModifiers? opAnnotation? statementEnd ;
foldStatement : OPEN_FOLD tagOpModifiers? opAnnotation? statementEnd ;
sendStatement : OPEN_SEND termModifiers opAnnotation? statementEnd ;
midSend       : OPEN_SEND midModifiers? opAnnotation? statementEnd ;
execStatement : OPEN_EXEC execModifiers? opAnnotation? statementEnd ;
bareStatement : OPEN_BARE tagSignal? opAnnotation? statementEnd ;
workStatement : OPEN_WORK branchModifiers? opAnnotation? statementEnd ;
forkStatement : OPEN_FORK branchModifiers? opAnnotation? statementEnd ;
killStatement : OPEN_KILL intOpModifiers? opAnnotation? statementEnd ;
planStatement : OPEN_PLAN tagOpModifiers? opAnnotation? statementEnd ;
lookStatement : OPEN_LOOK tagOpModifiers? opAnnotation? statementEnd ;
buffStatement : OPEN_BUFF tagOpModifiers? opAnnotation? statementEnd ;

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
    : tagSignal resourceSelection resourceSelection
    | resourceSelection tagSignal resourceSelection
    | resourceSelection resourceSelection tagSignal?
    ;

resourceSelection
    : targetWithMetadata lineMarker?
    ;

emptyStatementEnd
    : SECTION_END
    | BODY_OPEN SECTION_END?
    |
    ;

tagOpModifiers
    : tagSignal (targetWithMetadata lineMarker? | lineMarker targetWithMetadata?)?
    | targetWithMetadata (tagSignal lineMarker? | lineMarker tagSignal?)?
    | lineMarker (tagSignal targetWithMetadata? | targetWithMetadata tagSignal?)?
    ;

intOpModifiers
    : intSignal targetWithMetadata?
    | targetWithMetadata intSignal?
    ;

branchModifiers
    : branchSignal targetWithMetadata?
    | targetWithMetadata branchSignal?
    ;

termModifiers
    : dispSignal targetWithMetadata? lineMarker?
    | targetWithMetadata dispSignal lineMarker?
    ;

midModifiers
    : midSignal targetWithMetadata?
    | targetWithMetadata midSignal?
    ;

// EXEC takes a runtime signal and, separately, a tag signal ({§exec-tag-signal});
// the visitor admits each slot at most once.
execModifiers
    : execSlot+
    ;
execSlot
    : identSignal
    | tagSignal
    | targetWithMetadata
    | lineMarker
    ;

tagSignal   : LBRACKET (TAG | COMMA)* RBRACKET ;
branchSignal: LBRACKET TAG RBRACKET ;
intSignal   : LBRACKET (INT | DISPOSITION)? RBRACKET ;
midSignal   : LBRACKET INT? RBRACKET ;
dispSignal  : LBRACKET DISPOSITION RBRACKET ;
identSignal : LBRACKET IDENT? RBRACKET ;

target      : LPAREN TARGET_TEXT* RPAREN ;
targetWithMetadata : target metadata* ;
metadata    : LBRACE METADATA_TEXT* RBRACE ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
