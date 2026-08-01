import {
    BaseErrorListener,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
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
        _offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        const translated = this.source === "lexer"
            ? PlurnkErrorStrategy.translateLexerMessage(recognizer as plurnkLexer, msg)
            : msg;
        this.errors.push(new PlurnkParseError(line, column, this.source, translated));
    }
}
