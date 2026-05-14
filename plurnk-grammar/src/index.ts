import {
    BaseErrorListener,
    CharStream,
    CommonTokenStream,
    DefaultErrorStrategy,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type StatementContext } from "./generated/plurnkParser.ts";

export type Position = { line: number; column: number };

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

export type ParseItem =
    | { kind: "statement"; tree: StatementContext; position: Position }
    | { kind: "error"; error: PlurnkParseError }
    | { kind: "text"; text: string; position: Position };

export type ParseResult = {
    items: ParseItem[];
    unparsedTail?: { from: Position; reason: string };
};

class RecordingListener extends BaseErrorListener {
    readonly errors: PlurnkParseError[];
    readonly source: "lexer" | "parser";

    constructor(source: "lexer" | "parser", errors: PlurnkParseError[]) {
        super();
        this.source = source;
        this.errors = errors;
    }

    override syntaxError(
        _recognizer: Recognizer<any>,
        _offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        this.errors.push(new PlurnkParseError(line, column, this.source, msg));
    }
}

const errorInRange = (
    err: PlurnkParseError,
    start: { line: number; column: number },
    stop: { line: number; column: number },
): boolean => {
    if (err.line < start.line || err.line > stop.line) return false;
    if (err.line === start.line && err.column < start.column) return false;
    if (err.line === stop.line && err.column > stop.column) return false;
    return true;
};

export const parse = (input: string): ParseResult => {
    const lexer = new plurnkLexer(CharStream.fromString(input));
    const errors: PlurnkParseError[] = [];
    lexer.removeErrorListeners();
    lexer.addErrorListener(new RecordingListener("lexer", errors));

    const tokenStream = new CommonTokenStream(lexer);
    const parser = new plurnkParser(tokenStream);
    parser.removeErrorListeners();
    parser.addErrorListener(new RecordingListener("parser", errors));
    parser.errorHandler = new DefaultErrorStrategy();

    const tree = parser.document();

    const items: ParseItem[] = [];
    const consumedErrors = new Set<PlurnkParseError>();

    for (const child of tree.children ?? []) {
        const ctx = child as any;
        const start = ctx.start ?? ctx.symbol;
        const stop = ctx.stop ?? ctx.symbol;
        if (!start) continue;

        const position: Position = { line: start.line, column: start.column };

        if (ctx.ruleIndex === plurnkParser.RULE_statement) {
            const errForStatement = errors.find(
                (e) => !consumedErrors.has(e) && errorInRange(e, start, stop ?? start),
            );
            if (errForStatement) {
                consumedErrors.add(errForStatement);
                items.push({ kind: "error", error: errForStatement });
            } else {
                items.push({ kind: "statement", tree: ctx as StatementContext, position });
            }
        } else if (ctx.symbol?.type === plurnkLexer.TEXT) {
            items.push({ kind: "text", text: ctx.symbol.text ?? "", position });
        }
    }

    // Any remaining errors that didn't get associated with a statement
    // (e.g., orphan lexer errors) get appended in order.
    for (const err of errors) {
        if (!consumedErrors.has(err)) {
            items.push({ kind: "error", error: err });
        }
    }

    // Detect a boundary-destroying error: lexer ended in a non-DEFAULT mode,
    // typically meaning a statement was never closed.
    let unparsedTail: ParseResult["unparsedTail"];
    if (lexer.mode !== 0) {
        const lastToken = tokenStream.get(tokenStream.size - 1);
        unparsedTail = {
            from: { line: lastToken?.line ?? 0, column: lastToken?.column ?? 0 },
            reason: `lexer ended in non-default mode (${lexer.mode}); a statement was likely never closed`,
        };
    }

    return { items, unparsedTail };
};
