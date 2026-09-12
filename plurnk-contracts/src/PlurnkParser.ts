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
    PLURNK_OPS,
    type ClientStatement,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
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

// One-turn containers, flattened in source order for model and saved programs.
const CONTAINER_RULES = new Set<number>([
    plurnkParser.RULE_modelTurn,
    plurnkParser.RULE_turn,
]);

export default class PlurnkParser {
    static readonly NO_VALID_OPERATION = "no valid Plurnk operation was found.";

    static frame(header: string, body: string | null): string {
        const longest = (body?.match(/`+/g) ?? []).reduce((maximum, ticks) => Math.max(maximum, ticks.length), 0);
        const fence = "`".repeat(Math.max(4, longest + 1));
        return `${fence}${header}\n${body === null ? "" : `${body}\n`}${fence}`;
    }

    // {§statement-rendering} — framing is syntax, never persisted AST state.
    static stringify(statements: readonly ClientStatement[]): string {
        return statements.map((statement) => {
            const name = statement.op === "EXEC" ? statement.executor ?? "EXEC" : statement.op;
            if (statement.op === "EXEC" && statement.executor !== null
                && [...PLURNK_OPS, "LOOK"].includes(name)) {
                throw new TypeError(`Executor name ${JSON.stringify(name)} is reserved for a Plurnk operation.`);
            }
            const modifiers: string[] = [];
            // {§matcher-option} — a lifted matcher whose block left no metadata behind is written back
            // as its `pattern` option; a retained block already carries it verbatim.
            const metadataOf = (metadata: readonly string[] | null | undefined, matcher: { raw: string } | null | undefined): string[] =>
                metadata !== null && metadata !== undefined ? metadata.map((block) => `[${block}]`)
                    : matcher !== null && matcher !== undefined ? [`[${JSON.stringify({ pattern: matcher.raw })}]`]
                        : [];
            const selection = (resource: ResourceSelection): void => {
                modifiers.push(`(${resource.target.raw})`);
                if (resource.lineMarker !== null) modifiers.push(`<${resource.lineMarker.marks.join(",")}>`);
                modifiers.push(...metadataOf(resource.metadata, resource.matcher));
            };
            if (statement.op === "COPY" || statement.op === "MOVE") {
                selection(statement.source);
                selection(statement.destination);
            } else {
                if (statement.target !== null) {
                    modifiers.push(`(${statement.target.raw})`);
                }
                if (statement.lineMarker !== null) modifiers.push(`<${statement.lineMarker.marks.join(",")}>`);
                modifiers.push(...metadataOf(statement.metadata, "matcher" in statement ? statement.matcher : null));
            }
            if (statement.aside !== null) modifiers.push(`<!-- ${statement.aside} -->`);
            const body = TurnDisposition.is(statement) ? PlanValue.stringify(statement.body)
                : statement.op === "COPY" || statement.op === "MOVE" || statement.body === null ? null
                : typeof statement.body === "string" ? statement.body : statement.body.raw;
            const header = `${name}${modifiers.length === 0 ? "" : ` ${modifiers.join(" ")}`}`;
            return PlurnkParser.frame(header, body);
        }).join("\n\n");
    }

    // Parse one model turn. An omitted disposition is silent continuation; a present one
    // may sit anywhere in the turn ({§disposition-anywhere}) and the runtime executes it last.
    // Outside text never becomes a parse item. {§whitespace-contract} {§turn-shape}
    static parse(input: string): ParseResult {
        const result = PlurnkParser.#run(input, (parser) => parser.document());
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        if (result.unparsedTail === undefined) PlurnkParser.#requireSourceOperation(result.items);
        return result;
    }

    // {§turn-shape} — no source operation is an admission failure, not missing TASK.
    static #requireSourceOperation(items: ParseItem<PlurnkStatement>[]): void {
        if (items.some((item) => item.kind === "statement")) return;
        const isStructErr = (i: ParseItem<any>) => i.kind === "error" && i.error.source === "parser" && i.error.severity === "error";
        const structErrors = items.filter(isStructErr);
        const anchor = (structErrors[0] as { error: PlurnkParseError } | undefined)?.error;
        // Lexer and visitor diagnostics remain intact.
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
    // documentation snippets. No turn shape; outside text is ignored in every tier.
    // Not for model output; use `parse` for that.
    static parseStatements(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq());
    }

    // Parse saved turns in source order; dispositions separate them. Each turn
    // requires a disposition, including when ordinary operations follow it.
    static parseLog(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.log());
    }

    // Parse the CLIENT tier - a bare sequence of protocol statements plus the client-only utility
    // op LOOK. The topmost subset (one above Script); never used for model output. The
    // protocol entry points reject LOOK, so a client op only parses here.
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
            ? `metadata modifier of \`${heading}\` opened at line ${from.line} but never closed - add \`]\``
            : modeName === "TARGET"
                ? `target slot of \`${heading}\` opened at line ${from.line} but never closed - add \`)\``
                : `${openTag} block opened at line ${from.line} but was not closed with ${lexer.getFenceLength()} backticks`;
        return { from, reason };
    }

    // Walk statement containers in source order; bounded malformed statements become errors.
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
                        // {§misplaced-aside-advisory} — the builder's advisories follow their statement.
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
