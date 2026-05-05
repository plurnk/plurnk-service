// Headers-only Markdown lexer.
//
// Every token consumes a full line including the trailing newline. That makes
// "must be at start of line" implicit — the lexer always resumes at column 0
// after each token. No semantic predicates, no custom base class.
//
// Fenced code blocks switch to FENCED mode so '#' lines inside them are not
// mistaken for headings.

lexer grammar MarkdownLexer;

ATX_LINE
    : ' '? ' '? ' '? '#' '#'? '#'? '#'? '#'? '#'? [ \t] ~[\r\n]* ('\r'? '\n' | EOF)
    ;

FENCE_OPEN
    : ' '? ' '? ' '? ('```' '`'* | '~~~' '~'*) ~[\r\n]* ('\r'? '\n' | EOF)
      -> pushMode(FENCED)
    ;

OTHER_LINE
    : ~[\r\n]* ('\r'? '\n' | EOF)
    ;

mode FENCED;

FENCE_CLOSE
    : ' '? ' '? ' '? ('```' '`'* | '~~~' '~'*) [ \t]* ('\r'? '\n' | EOF)
      -> popMode
    ;

FENCED_BODY
    : ~[\r\n]* ('\r'? '\n' | EOF) -> skip
    ;
