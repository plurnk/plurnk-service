import {
    BailErrorStrategy,
    BaseErrorListener,
    CharStream,
    CommonTokenStream,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";

export class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: "lexer" | "parser";

    constructor(line: number, column: number, source: "lexer" | "parser", message: string) {
        super(`Plurnk ${source} error at ${line}:${column} — ${message}`);
        this.name = "PlurnkParseError";
        this.line = line;
        this.column = column;
        this.source = source;
    }
}

class ThrowingListener extends BaseErrorListener {
    readonly source: "lexer" | "parser";

    constructor(source: "lexer" | "parser") {
        super();
        this.source = source;
    }

    override syntaxError(
        _recognizer: Recognizer<any>,
        _offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        throw new PlurnkParseError(line, column, this.source, msg);
    }
}

export const parse = (input: string) => {
    const lexer = new plurnkLexer(CharStream.fromString(input));
    lexer.removeErrorListeners();
    lexer.addErrorListener(new ThrowingListener("lexer"));

    const parser = new plurnkParser(new CommonTokenStream(lexer));
    parser.removeErrorListeners();
    parser.addErrorListener(new ThrowingListener("parser"));
    parser.errorHandler = new BailErrorStrategy();

    try {
        return parser.document();
    } catch (e: any) {
        if (e instanceof PlurnkParseError) throw e;
        // BailErrorStrategy throws ParseCancellationException; extract token info from its cause.
        const cause = e?.cause;
        const tok = cause?.offendingToken;
        const line = tok?.line ?? 0;
        const column = tok?.column ?? 0;
        const msg = cause?.message || e?.message || "parse error";
        throw new PlurnkParseError(line, column, "parser", msg);
    }
};
