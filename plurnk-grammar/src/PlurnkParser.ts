import { CharStream, CommonTokenStream, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import type { ParseItem, ParseResult, Position } from "./types.ts";

// The strict turn root attaches PLAN, ops, and the terminal SEND as direct children;
// all three are statement-bearing contexts the extraction builds into items.
const STATEMENT_RULES = new Set<number>([
    plurnkParser.RULE_statement,
    plurnkParser.RULE_planStatement,
    plurnkParser.RULE_sendStatement,
]);

export default class PlurnkParser {
    // Parse a model TURN — the `*:PLAN:OPS:SEND[N]` sandwich, enforced entirely by the
    // grammar's `document` rule: free text before PLAN, a required PLAN, ops separated by
    // nothing but (hidden) whitespace, and a required terminal SEND. A packet without a
    // PLAN and a closing SEND does NOT parse — it surfaces as error items. This is THE
    // parse: a Plurnk packet IS a turn. There is no permissive fallback.
    static parse(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.document());
    }

    // Parse a bare sequence of statements — teaching-example collections, single ops,
    // documentation snippets. Strict: statements only (whitespace is hidden), no prose,
    // no turn shape. Not for model output; use `parse` for that.
    static parseStatements(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq());
    }

    static #run(input: string, parseFn: (parser: plurnkParser) => ParserRuleContext): ParseResult {
        const lexer = new plurnkLexer(CharStream.fromString(input));
        const errors: PlurnkParseError[] = [];
        lexer.removeErrorListeners();
        lexer.addErrorListener(new RecordingListener("lexer", errors));

        const tokenStream = new CommonTokenStream(lexer);
        const parser = new plurnkParser(tokenStream);
        parser.removeErrorListeners();
        parser.addErrorListener(new RecordingListener("parser", errors));
        parser.errorHandler = new PlurnkErrorStrategy();

        const tree = parseFn(parser);

        const items: ParseItem[] = [];
        const consumedErrors = new Set<PlurnkParseError>();

        for (const child of tree.children ?? []) {
            const ctx = child as any;
            const start = ctx.start ?? ctx.symbol;
            const stop = ctx.stop ?? ctx.symbol;
            if (!start) continue;

            if (ctx.ruleIndex !== undefined && STATEMENT_RULES.has(ctx.ruleIndex)) {
                const errForStatement = errors.find(
                    (e) => !consumedErrors.has(e) && PlurnkParser.#errorInRange(e, start, stop ?? start),
                );
                if (errForStatement) {
                    consumedErrors.add(errForStatement);
                    items.push({ kind: "error", error: errForStatement });
                } else {
                    try {
                        items.push({ kind: "statement", statement: AstBuilder.build(ctx) });
                    } catch (e) {
                        // A malformed context from error recovery (e.g. a phantom PLAN with
                        // no open token, synthesized when a non-turn is parsed as a turn)
                        // can't build — surface it as an error item, never crash.
                        const err = e instanceof PlurnkParseError
                            ? e
                            : new PlurnkParseError(start.line, start.column, "parser", e instanceof Error ? e.message : String(e));
                        items.push({ kind: "error", error: err });
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
            const openTag = lexer.getOpenTag();
            const from = { line: lexer.getOpenTagLine(), column: lexer.getOpenTagColumn() };
            const modeName = lexer.modeNames[lexer.mode] ?? "";
            const reason = modeName === "BODY"
                ? `body of \`<<${openTag}\` opened at line ${from.line} but never closed — add \`:${openTag}\` to terminate`
                : modeName === "SIGNAL_TAGS" || modeName === "SIGNAL_INT" || modeName === "SIGNAL_IDENT"
                    ? `signal slot of \`<<${openTag}\` opened at line ${from.line} but never closed — add \`]\` to terminate the signal`
                    : modeName === "TARGET"
                        ? `target slot of \`<<${openTag}\` opened at line ${from.line} but never closed — add \`)\` to terminate the target`
                        : `statement \`<<${openTag}\` opened at line ${from.line} but never reached its close tag — add \`:${openTag}\` to terminate`;
            unparsedTail = { from, reason };
        }

        return { items, unparsedTail };
    }

    static #errorInRange(
        err: PlurnkParseError,
        start: { line: number; column: number },
        stop: { line: number; column: number },
    ): boolean {
        if (err.line < start.line || err.line > stop.line) return false;
        if (err.line === start.line && err.column < start.column) return false;
        if (err.line === stop.line && err.column > stop.column) return false;
        return true;
    }
}
