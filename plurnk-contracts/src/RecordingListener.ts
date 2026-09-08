import {
    BaseErrorListener,
    ParserRuleContext,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
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
        offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        let duplicateDisposition = false;
        if (recognizer instanceof plurnkParser && offendingSymbol !== null && [
            plurnkParser.OPEN_NEXT, plurnkParser.OPEN_WAIT, plurnkParser.OPEN_DONE, plurnkParser.OPEN_FAIL,
        ].includes(offendingSymbol.type)) {
            const containsDisposition = (context: ParserRuleContext): boolean =>
                context.ruleIndex === plurnkParser.RULE_dispositionStatement
                || context.children.some((child) => child instanceof ParserRuleContext && containsDisposition(child));
            for (let context = recognizer.context; context !== null; context = context.parent) {
                if (containsDisposition(context)) { duplicateDisposition = true; break; }
            }
        }
        const structural = duplicateDisposition || recognizer instanceof plurnkParser
            && [plurnkParser.RULE_document, plurnkParser.RULE_log].includes(recognizer.context?.ruleIndex ?? -1);
        const translated = duplicateDisposition
            ? "A turn permits only one disposition: NEXT, WAIT, DONE, or FAIL."
            : this.source === "lexer"
            ? PlurnkErrorStrategy.translateLexerMessage(recognizer as plurnkLexer, msg)
            : msg;
        this.errors.push(new PlurnkParseError(line, column, this.source, translated, "error", structural ? "invalid-turn-structure" : undefined));
    }
}
