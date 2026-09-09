import { CharStream, CommonTokenStream, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type ClientStatementContext } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlanValue from "./PlanValue.ts";
import TurnDisposition from "./TurnDisposition.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import {
    UNKNOWN_POSITION,
    PLURNK_OPS,
    type ClientStatement,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
    type DispositionStatement,
    type ResourceSelection,
} from "./types.ts";

// Statement-bearing contexts the extraction builds into items. `statement` (statementSeq) and
// `midStatement` (mid-turn ops) each wrap one op; the turn disposition attaches as a direct
// `dispositionStatement` child of a turn; `clientStatement` wraps one op in the
// client tier.
const STATEMENT_RULES = new Set<number>([
    plurnkParser.RULE_statement,
    plurnkParser.RULE_midStatement,
    plurnkParser.RULE_dispositionStatement,
    plurnkParser.RULE_clientStatement,
]);

// Container rules whose children hold one turn's statements. `turnContent`
// carries tolerated preamble text; `turn` is also the direct child of a fenced
// document. parseLog contains multiple turnContent siblings, flattened in order.
const CONTAINER_RULES = new Set<number>([
    plurnkParser.RULE_modelTurnContent,
    plurnkParser.RULE_modelTurn,
    plurnkParser.RULE_turnContent,
    plurnkParser.RULE_turn,
]);

export default class PlurnkParser {
    static readonly MISSING_DISPOSITION = "missing-turn-disposition";
    static readonly OPERATIONS_AFTER_DISPOSITION = "operations-after-disposition";
    static readonly NO_VALID_OPERATION = "no valid Plurnk operation was found.";

    static frame(header: string, body: string | null): string {
        const longest = (body?.match(/`+/g) ?? []).reduce((maximum, ticks) => Math.max(maximum, ticks.length), 0);
        const fence = "`".repeat(Math.max(4, longest + 1));
        return body === null ? `${fence}${header}${fence}` : `${fence}${header}\n${body}\n${fence}`;
    }

    // {§statement-rendering} — framing is syntax, never persisted AST state.
    static stringify(statements: readonly ClientStatement[]): string {
        return statements.map((statement) => {
            const name = statement.op === "EXEC" ? statement.executor ?? "EXEC" : statement.op;
            if (statement.op === "EXEC" && statement.executor !== null
                && [...PLURNK_OPS, "LOOK", "BUFF"].includes(name)) {
                throw new TypeError(`Executor name ${JSON.stringify(name)} is reserved for a Plurnk operation.`);
            }
            const modifiers: string[] = [];
            const selection = (resource: ResourceSelection): void => {
                modifiers.push(`(${resource.target.raw})`);
                for (const metadata of resource.metadata ?? []) modifiers.push(`{${metadata}}`);
                if (resource.lineMarker !== null) modifiers.push(`<${resource.lineMarker.marks.join(",")}>`);
            };
            if (statement.op === "COPY" || statement.op === "MOVE") {
                selection(statement.source);
                selection(statement.destination);
            } else {
                if (statement.target !== null) {
                    modifiers.push(`(${statement.target.raw})`);
                }
                for (const metadata of statement.metadata ?? []) modifiers.push(`{${metadata}}`);
                if (statement.lineMarker !== null) modifiers.push(`<${statement.lineMarker.marks.join(",")}>`);
            }
            if (statement.annotation !== null) modifiers.push(`<!-- ${statement.annotation} -->`);
            const body = TurnDisposition.is(statement) ? PlanValue.stringify(statement.body)
                : statement.op === "COPY" || statement.op === "MOVE" || statement.body === null ? null
                : typeof statement.body === "string" ? statement.body : statement.body.raw;
            const header = `${name}${modifiers.length === 0 ? "" : ` ${modifiers.join(" ")}`}`;
            return PlurnkParser.frame(header, body);
        }).join("\n");
    }

    // Parse one model turn. A source operation lets ingestion recover an omitted disposition.
    // Tolerated preamble TEXT remains an ordered item without language semantics. {§turn-shape}
    static parse(input: string): ParseResult {
        const result = PlurnkParser.#run(input, (parser) => parser.document());
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        if (result.unparsedTail === undefined) {
            PlurnkParser.#imperativeTurnShape(result.items, input);
            PlurnkParser.#recoverTurnEnvelope(result.items);
            PlurnkParser.#dispositionEndsTurn(result.items);
        }
        return result;
    }

    // Terminal disposition alphabet. {§waitpid-dispositions} {§wait-obligation-matrix}

    // Replace ANTLR's generic structure errors with the exact envelope default when the
    // operation/disposition shape is cleanly incomplete. The parser admits the useful
    // operations and core records this hard diagnostic as the turn's strike. {§turn-shape}
    static #imperativeTurnShape(items: ParseItem<any>[], input: string): void {
        // {§turn-shape} — only the turn disposition is structural. A
        // recipient SEND does not satisfy it ({§turn-disposition}).
        const hasDisposition = items.some(
            (i: any) => i.kind === "statement" && TurnDisposition.is(i.statement),
        );
        if (hasDisposition) return;
        const isStructErr = (i: ParseItem<any>) => i.kind === "error" && i.error.source === "parser" && i.error.severity === "error";
        const structErrors = items.filter(isStructErr);
        const statements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (statements.length === 0) {
            const anchor = (structErrors[0] as { error: PlurnkParseError } | undefined)?.error;
            // With no operation to retain, the grammar's expected-token cascade is less useful
            // than the exact admission failure. Lexer and visitor diagnostics remain intact.
            const kept = items.filter((item) => !isStructErr(item));
            items.length = 0;
            items.push(...kept, {
                kind: "error",
                error: new PlurnkParseError(
                    anchor?.line ?? 1,
                    anchor?.column ?? 0,
                    "parser",
                    PlurnkParser.NO_VALID_OPERATION,
                ),
            });
            return;
        }
        // {§error-shape}: a failed document boundary leaves later source unparsed,
        // not absent. Bounded lexer/visitor errors likewise already identify the failure.
        const hasSpecificError = items.some(
            (i) => i.kind === "error" && i.error.severity === "error"
                && (i.error.source !== "parser" || i.error.code === "invalid-turn-structure"),
        );
        if (hasSpecificError) return;
        if (!hasDisposition) {
            const position = {
                line: input.split("\n").length,
                column: [...input.slice(input.lastIndexOf("\n") + 1)].length,
            };
            items.push({
                kind: "error",
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    "No tasks were supplied. Submit a nonempty TASK inventory.",
                    "error",
                    PlurnkParser.MISSING_DISPOSITION,
                ),
            });
        }
    }

    // {§disposition-ends-turn} — coalesce trailing operations and their bounded diagnostics
    // without hiding a duplicate disposition. parseLog retains the complete authored source.
    static #dispositionEndsTurn(items: ParseItem<PlurnkStatement>[]): void {
        const at = items.findIndex((item) => item.kind === "statement" && TurnDisposition.is(item.statement));
        if (at === -1) return;
        const disposition = (items[at] as { statement: DispositionStatement }).statement;
        // A disposition the parser synthesized ({§turn-shape} recovery) closes the source; nothing authored follows it.
        if (disposition.position.line === UNKNOWN_POSITION.line) return;
        // The cut is the first trailing statement or the first hard bounded diagnostic past the
        // disposition heading (a malformed trailing heading). The disposition's own advisories are
        // spliced right after it and carry its line, so they stay.
        const trailing = (item: ParseItem<PlurnkStatement>): boolean => item.kind === "statement"
            || (item.kind === "error" && item.error.severity === "error" && item.error.code !== "invalid-turn-structure" && item.error.line > disposition.position.line);
        const cut = items.findIndex((item, index) => index > at && trailing(item));
        if (cut === -1) return;
        const kept: ParseItem<PlurnkStatement>[] = items.slice(0, cut);
        const counts = new Map<string, number>();
        let malformed = 0;
        let anchor: { line: number; column: number } | undefined;
        for (const item of items.slice(cut)) {
            if (item.kind === "statement") {
                counts.set(item.statement.op, (counts.get(item.statement.op) ?? 0) + 1);
                anchor ??= item.statement.position;
            } else if (item.kind === "error") {
                if (item.error.code === "invalid-turn-structure") { kept.push(item); continue; }
                if (item.error.severity === "error") { malformed += 1; anchor ??= { line: item.error.line, column: item.error.column }; }
            }
        }
        const dropped = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const parts: string[] = [];
        if (dropped > 0) {
            const byOp = [...counts].map(([op, count]) => `${op} ×${count}`).join(", ");
            parts.push(dropped === 1 ? `1 operation after its body was not admitted (${byOp})` : `${dropped} operations after its body were not admitted (${byOp})`);
        }
        if (malformed > 0) parts.push(malformed === 1 ? "1 malformed heading after it was ignored" : `${malformed} malformed headings after it were ignored`);
        const heading = disposition.op;
        kept.push({
            kind: "error",
            error: new PlurnkParseError(
                anchor?.line ?? disposition.position.line,
                anchor?.column ?? 0,
                "parser",
                `\`${heading}\` ended the turn; ${parts.join(" and ")}. Other operations precede TASK.`,
                "error",
                PlurnkParser.OPERATIONS_AFTER_DISPOSITION,
            ),
        });
        items.length = 0;
        items.push(...kept);
    }

    // A model emission with at least one valid operation remains a useful program when it
    // omits envelope ceremony. Materialize the exact language defaults in the AST; the raw
    // source remains untouched as forensic turnOps evidence. GBNF and parseLog stay strict.
    static #recoverTurnEnvelope(items: ParseItem<PlurnkStatement>[]): void {
        const sourceStatements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (sourceStatements.length === 0) return;
        const hasDisposition = sourceStatements.some(
            (statement) => TurnDisposition.is(statement),
        );
        if (!hasDisposition) {
            const disposition: DispositionStatement = {
                op: "TASK",
                annotation: null,
                target: null,
                metadata: null,
                lineMarker: null,
                body: [],
                position: UNKNOWN_POSITION,
            };
            const lastStatement = items.findLastIndex((item) => item.kind === "statement");
            items.splice(lastStatement + 1, 0, { kind: "statement", statement: disposition });
        }
    }

    // Collapse a lexer per-character cascade: the SIGNAL/TARGET modes emit one 'unrecognized
    // character' error PER bad char, so a single malformed `[signal]` floods 10+ near-identical
    // rows. Keep the first of each consecutive same-context run (adjacent columns, same mode
    // context) - the model needs one steer to the fix, not a per-character wall. Mutates in place.
    static #dedupeLexerCascade(errors: PlurnkParseError[]): void {
        for (let i = errors.length - 1; i >= 1; i--) {
            const cur = errors[i];
            const prev = errors[i - 1];
            if (cur.source !== "lexer" || prev.source !== "lexer") continue;
            if (cur.line !== prev.line || cur.column !== prev.column + 1) continue;
            if (PlurnkParser.#lexerContext(cur.message) !== PlurnkParser.#lexerContext(prev.message)) continue;
            errors.splice(i, 1);
        }
    }

    // The mode-context tail of a lexer message (the part after `unrecognized character <ch> `),
    // e.g. `in signal - expected integer for SEND/KILL, then \`]\``. Two adjacent chars sharing
    // it belong to the same cascade.
    static #lexerContext(message: string): string {
        const m = /unrecognized character (?:'[^']*'|end of input) (.+)$/.exec(message);
        return m ? m[1] : message;
    }

    // Parse a bare sequence of statements - teaching-example collections, single ops,
    // documentation snippets. Strict: statements only (whitespace is hidden), no prose,
    // no turn shape. Not for model output; use `parse` for that.
    static parseStatements(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq());
    }

    // Parse saved turns in source order; dispositions separate them. Each turn
    // requires a disposition, including when ordinary operations follow it.
    static parseLog(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.log());
    }

    // Parse the CLIENT tier - a bare sequence of protocol statements plus the client-only utility
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
        PlurnkParser.#dedupeLexerCascade(errors);
        const unparsedTail = PlurnkParser.#unparsedTail(lexer);

        const items: ParseItem<S>[] = [];
        const consumedErrors = new Set<PlurnkParseError>();
        PlurnkParser.#collect(tree, errors, consumedErrors, items, buildFn, unparsedTail?.from);
        // {§heading-inline-body} — a body that began on the heading line ran as the body; say so,
        // right after its statement, so the form is learned from the packet, not from silence.
        for (const note of lexer.takeInlineBodies()) {
            const advisory: ParseItem<S> = {
                kind: "error",
                error: new PlurnkParseError(
                    note.line,
                    note.column,
                    "parser",
                    `\`${note.heading.replace(/^`+/, "")}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`,
                    "warning",
                ),
            };
            const at = items.findIndex((item) => item.kind === "statement" && (item.statement as { position?: { line: number } }).position?.line === note.line);
            if (at !== -1) items.splice(at + 1, 0, advisory);
        }

        for (const err of errors) {
            if (!consumedErrors.has(err)
                && (unparsedTail === undefined || PlurnkParser.#isBefore(err, unparsedTail.from))) {
                items.push({ kind: "error", error: err });
            }
        }

        return { items, unparsedTail };
    }

    // Determine the public trust boundary before visiting recovered contexts. The parser may
    // synthesize tree nodes after an unfinished lexer mode, but those nodes have no public AST
    // meaning and can violate AstBuilder's complete-statement precondition. {§unparsed-tail-boundary}
    static #unparsedTail(lexer: plurnkLexer): ParseResult["unparsedTail"] {
        const modeName = lexer.modeNames[lexer.mode] ?? "";
        if (lexer.mode === 0) return undefined;
        const openTag = lexer.getOpenTag();
        const from = { line: lexer.getOpenTagLine(), column: lexer.getOpenTagColumn() };
        const heading = lexer.getOpenHeading().replace(/^`+/, "") || openTag;
        const reason = modeName === "METADATA"
            ? `metadata modifier of \`${heading}\` opened at line ${from.line} but never closed - add \`}\``
            : modeName === "TARGET"
                ? `target slot of \`${heading}\` opened at line ${from.line} but never closed - add \`)\``
                : `${openTag} block opened at line ${from.line} but was not closed with ${lexer.getFenceLength()} backticks`;
        return { from, reason };
    }

    // Walk a parse tree, appending statement/error/text items in source order. Statement rules
    // are leaves (built directly); container rules (turnContent) are recursed into; TEXT tokens
    // surface as text items. So `document` (one turnContent) and `log` (turnContent+) both
    // flatten to items in order, while a bounded malformed statement surfaces as an error item.
    static #collect<S extends ClientStatement>(
        ctx: ParserRuleContext,
        errors: PlurnkParseError[],
        consumedErrors: Set<PlurnkParseError>,
        items: ParseItem<S>[],
        buildFn: (ctx: any) => S,
        boundary?: Position,
    ): void {
        for (const child of ctx.children ?? []) {
            const c = child as any;
            const start = c.start ?? c.symbol;
            const stop = c.stop ?? c.symbol;
            if (!start) continue;
            if (boundary !== undefined && !PlurnkParser.#isBefore(start, boundary)) continue;

            if (c.ruleIndex !== undefined && STATEMENT_RULES.has(c.ruleIndex)) {
                const errorsForStatement = errors.filter(
                    (e) => !consumedErrors.has(e) && PlurnkParser.#errorInRange(e, start, stop ?? start),
                );
                const errForStatement = errorsForStatement[0];
                if (errForStatement) {
                    // One malformed statement projects one hard diagnostic. {§error-shape}
                    for (const error of errorsForStatement) consumedErrors.add(error);
                    items.push({ kind: "error", error: errForStatement });
                } else if ((c.getChildCount?.() ?? 0) === 0) {
                    // A phantom statement context synthesized during error recovery (e.g. a
                    // a required slot the parser opened then failed to fill): zero tokens
                    // matched, so its opening terminal is null and building it would null-deref.
                    // The real failure is already recorded; skip the zero-token recovery node.
                } else {
                    try {
                        items.push({ kind: "statement", statement: buildFn(c) });
                        // {§misplaced-annotation-advisory} — the builder's advisories follow their statement.
                        for (const advisory of AstBuilder.takeAdvisories()) items.push({ kind: "error", error: advisory });
                    } catch (e) {
                        // A genuine visitor contract violation (e.g. a malformed URI) is a
                        // PlurnkParseError - surface it as an error item. Anything else is an
                        // internal bug, not a parse error: let it crash rather than masquerade
                        // as a model-facing parse-error item.
                        if (!(e instanceof PlurnkParseError)) throw e;
                        items.push({ kind: "error", error: e });
                    }
                }
            } else if (c.ruleIndex !== undefined && CONTAINER_RULES.has(c.ruleIndex)) {
                PlurnkParser.#collect(c, errors, consumedErrors, items, buildFn, boundary);
            } else if (c.symbol?.type === plurnkLexer.TEXT) {
                const position: Position = { line: start.line, column: start.column };
                items.push({ kind: "text", text: c.symbol.text ?? "", position });
            }
        }
    }

    static #isBefore(point: { line: number; column: number }, boundary: Position): boolean {
        return point.line < boundary.line
            || (point.line === boundary.line && point.column < boundary.column);
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
