import {
    BaseErrorListener,
    CharStream,
    CommonTokenStream,
    type RecognitionException,
    type Recognizer,
    type Token,
} from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import { buildStatement, type PlurnkStatement, type Position } from "./ast.ts";
import { PlurnkParseError } from "./errors.ts";
import { PlurnkErrorStrategy, translateLexerMessage } from "./error-strategy.ts";

export { PlurnkParseError } from "./errors.ts";
export type { ErrorSource } from "./errors.ts";
export {
    type PlurnkStatement,
    type PlurnkOp,
    type Position,
    type LineMarker,
    type FindStatement,
    type ReadStatement,
    type EditStatement,
    type CopyStatement,
    type MoveStatement,
    type ShowStatement,
    type HideStatement,
    type SendStatement,
    type ExecStatement,
} from "./ast.ts";

export type ParseItem =
    | { kind: "statement"; statement: PlurnkStatement }
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
        recognizer: Recognizer<any>,
        _offendingSymbol: Token | null,
        line: number,
        column: number,
        msg: string,
        _e: RecognitionException | null,
    ): void {
        const translated = this.source === "lexer"
            ? translateLexerMessage(recognizer as plurnkLexer, msg)
            : msg;
        this.errors.push(new PlurnkParseError(line, column, this.source, translated));
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
    parser.errorHandler = new PlurnkErrorStrategy();

    const tree = parser.document();

    const items: ParseItem[] = [];
    const consumedErrors = new Set<PlurnkParseError>();

    for (const child of tree.children ?? []) {
        const ctx = child as any;
        const start = ctx.start ?? ctx.symbol;
        const stop = ctx.stop ?? ctx.symbol;
        if (!start) continue;

        if (ctx.ruleIndex === plurnkParser.RULE_statement) {
            const errForStatement = errors.find(
                (e) => !consumedErrors.has(e) && errorInRange(e, start, stop ?? start),
            );
            if (errForStatement) {
                consumedErrors.add(errForStatement);
                items.push({ kind: "error", error: errForStatement });
            } else {
                try {
                    items.push({ kind: "statement", statement: buildStatement(ctx) });
                } catch (e) {
                    if (e instanceof PlurnkParseError) {
                        items.push({ kind: "error", error: e });
                    } else {
                        throw e;
                    }
                }
            }
        } else if (ctx.symbol?.type === plurnkLexer.TEXT) {
            const position: Position = { line: start.line, column: start.column };
            items.push({ kind: "text", text: ctx.symbol.text ?? "", position });
        }
    }

    for (const err of errors) {
        if (!consumedErrors.has(err)) {
            items.push({ kind: "error", error: err });
        }
    }

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
