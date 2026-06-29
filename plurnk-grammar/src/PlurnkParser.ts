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
        const result = PlurnkParser.#run(input, (parser) => parser.document());
        // Value-adds layered on ANTLR's own diagnostics (we own syntax errors end to end):
        // near-miss op advisories on swallowed prose, then turn-shape imperatives. Both only
        // refine the model-facing message set; neither changes what parsed.
        PlurnkParser.#flagNearMissOps(result.items);
        PlurnkParser.#imperativeTurnShape(result.items);
        return result;
    }

    // Curated op-name confusions (semantic + dead-verb), NOT edit-distance — a full
    // `<<Word…:Word` heredoc carrying one of these is unambiguously an intended op, so the
    // false-positive rate is ~0. Bodies are never scanned (only DEFAULT-mode text items), so
    // the model's legitimate suffixed/embedded code is immune by construction.
    static #OP_CONFUSABLES: Record<string, string> = {
        CLOSE: "`<<FOLD`", HIDE: "`<<FOLD`", COLLAPSE: "`<<FOLD`",
        SHOW: "`<<OPEN`", EXPAND: "`<<OPEN`",
        DELETE: "`<<KILL`", REMOVE: "`<<KILL`", DROP: "`<<KILL`",
        GET: "`<<READ`", FETCH: "`<<READ`", CAT: "`<<READ`",
        WRITE: "`<<EDIT`", CREATE: "`<<EDIT`", UPDATE: "`<<EDIT`", SET: "`<<EDIT`",
        LIST: "`<<FIND`", SEARCH: "`<<FIND`", GREP: "`<<FIND`", QUERY: "`<<FIND`",
        RUN: "`<<EXEC`", SHELL: "`<<EXEC`",
        SPAWN: "`<<EDIT(run://name)` to spawn a run", FORK: "`<<COPY(run://self)` to fork the run",
    };

    // Surface near-miss ops that the forgiving parser swallowed as prose: a `<<Word…:Word`
    // heredoc whose keyword is a known confusion (`<<CLOSE`, `<<DELETE`, …). Emits a WARNING
    // (never an error — the input parsed), so a silent swallow becomes a steer toward canon.
    static #flagNearMissOps(items: ParseItem<any>[]): void {
        const additions: { at: number; item: ParseItem<any> }[] = [];
        items.forEach((item, idx) => {
            if (item.kind !== "text") return;
            const text = item.text;
            const opener = /<<([A-Za-z]+)/g;
            let m: RegExpExecArray | null;
            while ((m = opener.exec(text)) !== null) {
                const suggestion = PlurnkParser.#OP_CONFUSABLES[m[1].toUpperCase()];
                if (!suggestion) continue;
                // Op-shape gate: require a matching close `:Word` in the same run, so a bare
                // prose mention without a heredoc close is never flagged.
                if (!new RegExp(":" + m[1] + "\\b").test(text)) continue;
                const before = text.slice(0, m.index);
                const nl = before.split("\n").length - 1;
                const line = item.position.line + nl;
                const column = nl === 0 ? item.position.column + m.index : m.index - before.lastIndexOf("\n") - 1;
                additions.push({
                    at: idx,
                    item: {
                        kind: "error",
                        error: new PlurnkParseError(
                            line,
                            column,
                            "parser",
                            `\`<<${m[1]}\` is not a Plurnk operation, so it was read as text; did you mean ${suggestion}?`,
                            "warning",
                        ),
                    },
                });
            }
        });
        // Insert each advisory right after its text item (reverse order keeps indices valid).
        for (const { at, item } of additions.reverse()) items.splice(at + 1, 0, item);
    }

    // Replace ANTLR's generic structure errors with the turn-shape imperative when the
    // PLAN-anchored sandwich is broken. PLAN-first takes precedence: with no PLAN we cannot
    // judge the terminal SEND (it never reached statement position), so we only direct the
    // model to the anchor; a present-PLAN, absent-SEND turn gets the terminator imperative.
    static #imperativeTurnShape(items: ParseItem<any>[]): void {
        const ops = items.filter((i) => i.kind === "statement").map((i: any) => i.statement.op);
        const hasPlan = ops.includes("PLAN");
        const hasSend = ops.includes("SEND");
        if (hasPlan && hasSend) return;
        const isStructErr = (i: ParseItem<any>) => i.kind === "error" && i.error.source === "parser" && i.error.severity === "error";
        const structErrors = items.filter(isStructErr);
        if (structErrors.length === 0) return;
        const anchor = (structErrors[0] as { error: PlurnkParseError }).error;
        // Drop the generic parser structure errors (downstream noise from the broken shape);
        // keep statements, text, near-miss warnings, and lexer/visitor errors.
        const kept = items.filter((i) => !isStructErr(i));
        items.length = 0;
        items.push(...kept);
        // Only add the anchor imperative when the shape is CLEANLY incomplete. If a lexer or
        // visitor error is present, the turn derailed mid-op (e.g. an unclosed target), so the
        // missing PLAN/SEND is a parse artifact, not the real fix — that specific error plus the
        // unparsedTail is the actionable guidance, and an imperative would mislead.
        const hasSpecificError = items.some(
            (i) => i.kind === "error" && i.error.severity === "error" && i.error.source !== "parser",
        );
        if (hasSpecificError) return;
        const fix = !hasPlan
            ? "a turn must begin with `<<PLAN:…:PLAN` (the required first operation)"
            : "a turn must end with a terminal `<<SEND[code]:…:SEND` carrying the loop status";
        items.push({ kind: "error", error: new PlurnkParseError(anchor.line, anchor.column, "parser", fix) });
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
                } else if ((c.getChildCount?.() ?? 0) === 0) {
                    // A phantom statement context synthesized during error recovery (e.g. a
                    // PLAN slot the parser opened then failed to fill on bare text): zero tokens
                    // matched, so its OPEN terminal is null and building it would null-deref.
                    // The real failure is already a recorded grammar error; skip the phantom so
                    // an internal crash never leaks as a spurious parse-error item (#45).
                } else {
                    try {
                        items.push({ kind: "statement", statement: buildFn(c) });
                    } catch (e) {
                        // A genuine visitor contract violation (e.g. a malformed URI) is a
                        // PlurnkParseError — surface it as an error item. Anything else is an
                        // internal bug, not a parse error: let it crash rather than masquerade
                        // as a model-facing parse-error item (#45).
                        if (!(e instanceof PlurnkParseError)) throw e;
                        items.push({ kind: "error", error: e });
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
