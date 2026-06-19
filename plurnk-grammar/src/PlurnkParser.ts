import { CharStream, CommonTokenStream } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import type { ParseItem, ParseResult, Position } from "./types.ts";

export default class PlurnkParser {
    static parse(input: string): ParseResult {
        // A Plurnk turn is a `*:PLAN:OPS:SEND[N]` sandwich: the model's private reasoning
        // (any format — native channel, prose, nothing) precedes the first `<<PLAN`, which
        // anchors the actionable turn. Discard that preamble before lexing — the turn
        // begins at `<<PLAN`. Provider-separated content already starts there (no-op);
        // this also rescues un-separated raw content and prevents the lexer from
        // mis-tokenizing op-lookalikes a model may rehearse inside its reasoning. No
        // `<<PLAN` present ⇒ parse as-is (e.g. a statement list or the examples block).
        const planIdx = input.indexOf("<<PLAN");
        if (planIdx > 0) input = input.slice(planIdx);
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
                    (e) => !consumedErrors.has(e) && PlurnkParser.#errorInRange(e, start, stop ?? start),
                );
                if (errForStatement) {
                    consumedErrors.add(errForStatement);
                    items.push({ kind: "error", error: errForStatement });
                } else {
                    try {
                        items.push({ kind: "statement", statement: AstBuilder.build(ctx) });
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
