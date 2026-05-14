parser grammar plurnkParser;

options { tokenVocab = plurnkLexer; }

document
    : statement* EOF
    ;

statement
    : openTag signal? path? lineMarker? COLON body? CLOSE_TAG
    ;

openTag
    : OPEN_FIND
    | OPEN_READ
    | OPEN_EDIT
    | OPEN_COPY
    | OPEN_MOVE
    | OPEN_SHOW
    | OPEN_HIDE
    | OPEN_SEND
    | OPEN_EXEC
    ;

signal
    : LBRACKET SIGNAL_TEXT? RBRACKET
    ;

path
    : LPAREN PATH_TEXT? RPAREN
    ;

lineMarker
    : L_MARKER
    ;

body
    : BODY_TEXT+
    ;
