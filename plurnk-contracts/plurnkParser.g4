parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

// One model turn: optional provider/preamble TEXT, H1 PLAN, zero or more H2
// operations, and one disposition-coded terminal H2 SEND. {§turn-shape}
document
    : turnContent EOF
    | FENCE_OPEN turn FENCE_CLOSE EOF
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
    | workStatement
    | forkStatement
    | killStatement
    ;

findStatement : OPEN_FIND tagOpModifiers? statementEnd ;
readStatement : OPEN_READ tagOpModifiers? statementEnd ;
editStatement : OPEN_EDIT tagOpModifiers? statementEnd ;
copyStatement : OPEN_COPY tagOpModifiers? statementEnd ;
moveStatement : OPEN_MOVE tagOpModifiers? statementEnd ;
openStatement : OPEN_OPEN curationModifiers? statementEnd ;
foldStatement : OPEN_FOLD curationModifiers? statementEnd ;
sendStatement : OPEN_SEND termModifiers statementEnd ;
midSend       : OPEN_SEND midModifiers? statementEnd ;
execStatement : OPEN_EXEC execModifiers? statementEnd ;
workStatement : OPEN_WORK branchModifiers? statementEnd ;
forkStatement : OPEN_FORK branchModifiers? statementEnd ;
killStatement : OPEN_KILL intOpModifiers? statementEnd ;
planStatement : OPEN_PLAN tagOpModifiers? statementEnd ;
lookStatement : OPEN_LOOK tagOpModifiers? statementEnd ;
buffStatement : OPEN_BUFF tagOpModifiers? statementEnd ;

// A direct next heading, an ordinary section body, or EOF after a bodyless
// heading all normalize through the same AST path. {§empty-section}
statementEnd
    : SECTION_END
    | BODY_OPEN body? SECTION_END?
    |
    ;

tagOpModifiers
    : tagSignal (target lineMarker? | lineMarker target?)?
    | target (tagSignal lineMarker? | lineMarker tagSignal?)?
    | lineMarker (tagSignal target? | target tagSignal?)?
    ;

curationModifiers
    : tagSignal target?
    | target tagSignal?
    ;

intOpModifiers
    : intSignal target?
    | target intSignal?
    ;

branchModifiers
    : branchSignal target?
    | target branchSignal?
    ;

termModifiers
    : dispSignal target? lineMarker?
    | target dispSignal lineMarker?
    ;

midModifiers
    : midSignal target?
    | target midSignal?
    ;

execModifiers
    : identSignal (target lineMarker? | lineMarker target?)?
    | target (identSignal lineMarker? | lineMarker identSignal?)?
    | lineMarker (identSignal target? | target identSignal?)?
    ;

tagSignal   : LBRACKET (TAG | COMMA)* RBRACKET ;
branchSignal: LBRACKET TAG RBRACKET ;
intSignal   : LBRACKET (INT | DISPOSITION)? RBRACKET ;
midSignal   : LBRACKET INT? RBRACKET ;
dispSignal  : LBRACKET DISPOSITION RBRACKET ;
identSignal : LBRACKET IDENT? RBRACKET ;

target      : LPAREN TARGET_TEXT* RPAREN ;
lineMarker  : L_MARKER ;
body        : BODY_TEXT+ ;
