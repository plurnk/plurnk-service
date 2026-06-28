import { CharStream, CommonTokenStream, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type ClientStatementContext } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import type { ClientStatement, ParseItem, ParseResult, PlurnkStatement, Position } from "./types.ts";

// Statement-bearing contexts the extraction builds into items. `statement` (statementSeq) and
// `midStatement` (mid-turn ops) each wrap one op; PLAN and the terminal SEND attach as direct
// `planStatement`/`sendStatement` children of a turn; `clientStatement` wraps one op in the
// client tier.
const STATEMENT_RULES = new Set<number>([
    plurnkParser.RULE_statement,
    plurnkParser.RULE_midStatement,
    plurnkParser.RULE_planStatement,
    plurnkParser.RULE_sendStatement,
    plurnkParser.RULE_clientStatement,
]);

// Container rules whose children hold the statements — extraction recurses through these.
// `turnStatement` is the `<<TURN…:…:TURN` wrapper (log); `turnContent` is the sandwich inside
// it (and document's single turn). Recursing both flattens a wrapped log to its ops in order.
const CONTAINER_RULES = new Set<number>([
    plurnkParser.RULE_turnContent,
    plurnkParser.RULE_turnStatement,
]);

export default class PlurnkParser {
    // Parse a model TURN. Two hard requirements: a PLAN anchor (first op, only free-text
    // preamble may precede it) and a terminal SEND (carries the loop status code). A PLAN-less
    // or SEND-less packet does NOT parse and surfaces as error items. Prose is tolerated
    // anywhere else (preamble, between ops, trailing) and surfaces as text items — in Plurnk
    // Script that prose is the comment mechanism. The GBNF rail already requires PLAN, so the
    // rail and the parser agree (prose tolerance is the only place the parser stays lenient).
    static parse(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.document());
    }

    // Parse a bare sequence of statements — teaching-example collections, single ops,
    // documentation snippets. Strict: statements only (whitespace is hidden), no prose,
    // no turn shape. Not for model output; use `parse` for that.
    static parseStatements(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq());
    }

    // Parse a multi-turn LOG — a saved sequence of turns, each a full PLAN-anchored sandwich
    // (the v1 Plurnk Script substrate). Items are flat across turns, in source order; turn
    // boundaries are recoverable from the terminal SENDs. A log is valid (no error items, no
    // unparsedTail) iff every turn in it is a valid turn.
    static parseLog(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.log());
    }

    // Parse the CLIENT tier — a bare sequence of protocol statements plus the client-only utility
    // ops LOOK and BUFF. The topmost subset (one above Script); never used for model output. The
    // protocol entry points reject LOOK/BUFF, so a client op only parses here.
    static parseClient(input: string): ParseResult<ClientStatement> {
        return PlurnkParser.#run<ClientStatement>(
            input,
            (parser) => parser.clientStatementSeq(),
            (ctx) => AstBuilder.buildClient(ctx as ClientStatementContext),
        );
    }

    static #run<S extends ClientStatement = PlurnkStatement>(
        input: string,
        parseFn: (parser: plurnkParser) => ParserRuleContext,
        buildFn: (ctx: any) => S = ((ctx: any) => AstBuilder.build(ctx) as S),
    ): ParseResult<S> {
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

        const items: ParseItem<S>[] = [];
        const consumedErrors = new Set<PlurnkParseError>();
        PlurnkParser.#collect(tree, errors, consumedErrors, items, buildFn);

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

    // Walk a parse tree, appending statement/error/text items in source order. Statement rules
    // are leaves (built directly); container rules (turnContent) are recursed into; TEXT tokens
    // surface as text items. So `document` (one turnContent) and `log` (turnContent+) both
    // flatten to items in order, while a malformed statement surfaces as an error item.
    static #collect<S extends ClientStatement>(
        ctx: ParserRuleContext,
        errors: PlurnkParseError[],
        consumedErrors: Set<PlurnkParseError>,
        items: ParseItem<S>[],
        buildFn: (ctx: any) => S,
    ): void {
        for (const child of ctx.children ?? []) {
            const c = child as any;
            const start = c.start ?? c.symbol;
            const stop = c.stop ?? c.symbol;
            if (!start) continue;

            if (c.ruleIndex !== undefined && STATEMENT_RULES.has(c.ruleIndex)) {
                const errForStatement = errors.find(
                    (e) => !consumedErrors.has(e) && PlurnkParser.#errorInRange(e, start, stop ?? start),
                );
                if (errForStatement) {
                    consumedErrors.add(errForStatement);
                    items.push({ kind: "error", error: errForStatement });
                } else {
                    try {
                        items.push({ kind: "statement", statement: buildFn(c) });
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
            } else if (c.ruleIndex !== undefined && CONTAINER_RULES.has(c.ruleIndex)) {
                PlurnkParser.#collect(c, errors, consumedErrors, items, buildFn);
            } else if (c.symbol?.type === plurnkLexer.TEXT) {
                const position: Position = { line: start.line, column: start.column };
                items.push({ kind: "text", text: c.symbol.text ?? "", position });
            }
        }
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
