import {
    BaseErrorListener,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import { PlurnkParseError } from "@plurnk/plurnk-contracts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";

export default class RecordingListener extends BaseErrorListener {
    readonly errors: PlurnkParseError[];
    readonly source: "lexer" | "parser";

    constructor(source: "lexer" | "parser", errors: PlurnkParseError[]) {
        super();
        this.source = source;
        this.errors = errors;
    }

    override syntaxError(
        recognizer: Recognizer<any>,
        offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        const structural = recognizer instanceof plurnkParser
            && recognizer.context?.ruleIndex === plurnkParser.RULE_document;
        const translated = this.source === "lexer"
            ? PlurnkErrorStrategy.translateLexerMessage(recognizer as plurnkLexer, msg)
            : msg;
        this.errors.push(new PlurnkParseError(line, column, this.source, translated, "error", structural ? "invalid-turn-structure" : undefined));
    }
}
