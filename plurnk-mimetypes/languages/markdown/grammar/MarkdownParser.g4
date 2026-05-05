parser grammar MarkdownParser;

options { tokenVocab = MarkdownLexer; }

document : block* EOF ;

block
    : ATX_LINE                  # atxHeading
    | FENCE_OPEN FENCE_CLOSE?   # fencedCode
    | OTHER_LINE                # otherLine
    ;
