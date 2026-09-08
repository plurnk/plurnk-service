import { CharStream, CommonTokenStream, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type ClientStatementContext } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import {
    UNKNOWN_POSITION,
    type ClientStatement,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
    type SendStatement,
} from "./types.ts";

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
    static readonly MISSING_SEND = "missing-terminal-send";
    static readonly OPERATIONS_AFTER_DISPOSITION = "operations-after-disposition";
    static readonly NO_VALID_OPERATION = "no valid Plurnk operation was found.";

    // Parse one model turn. Canonical PLAN/SEND framing stays strict in teaching and
    // generation; a source operation lets ingestion recover either omitted boundary.
    // Tolerated preamble TEXT remains an ordered item without language semantics. {§turn-shape}
    static parse(input: string): ParseResult {
        const { source, tolerated: scoped } = PlurnkParser.#tolerateScopeSlots(input);
        const result = PlurnkParser.#run(source, (parser) => parser.document());
        PlurnkParser.#scoldScopeSlots(result.items, scoped);
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        if (result.unparsedTail === undefined) {
            PlurnkParser.#imperativeTurnShape(result.items, input);
            PlurnkParser.#recoverTurnEnvelope(result.items);
            PlurnkParser.#dispositionEndsTurn(result.items);
        }
        PlurnkParser.#adviseForeignLaneHeadings(result.items);
        return result;
    }

    // {§foreign-lane-advisory} — under {§lane-match} a heading whose suffix differs from the turn's
    // lane is body text, by design. When a body swallows OP-shaped headings, say so once, factually,
    // right after the statement that swallowed them: the model that numbered `EDIT1…EDIT23` learns in
    // one turn what it otherwise infers from a 1,136-line receipt; the model that nested a quoted
    // program on purpose reads a confirmation. Nothing is accepted, rewritten, or rejected (#515).
    static readonly #OP_SHAPED_HEADING = /^#{2,3} (PLAN|FIND|READ|EDIT|COPY|MOVE|EXEC|WORK|FORK|BARE|KILL|SEND)([A-Za-z0-9_]*)(?=\s|$)/u;
    static #adviseForeignLaneHeadings(items: ParseItem<any>[]): void {
        const advisories: Array<{ at: number; error: PlurnkParseError }> = [];
        items.forEach((item, index) => {
            if (item.kind !== "statement") return;
            const statement = item.statement as { op: string; delimiter?: string; body?: string | { raw?: string } | null; position?: Position };
            const body = typeof statement.body === "string" ? statement.body : statement.body?.raw;
            if (typeof body !== "string" || statement.position === undefined) return;
            const lane = statement.delimiter ?? "";
            const swallowed = new Map<string, { count: number; ops: Set<string>; line: number }>();
            body.split("\n").forEach((text, offset) => {
                const match = PlurnkParser.#OP_SHAPED_HEADING.exec(text);
                if (match === null || match[2] === lane) return;
                const entry = swallowed.get(match[2]) ?? { count: 0, ops: new Set<string>(), line: statement.position!.line + 1 + offset };
                entry.count += 1;
                entry.ops.add(match[1]);
                swallowed.set(match[2], entry);
            });
            for (const [suffix, entry] of swallowed) {
                const plural = entry.count === 1 ? "heading" : "headings";
                const shown = suffix === "" ? "no suffix" : `suffix \`${suffix}\``;
                const laneShown = lane === "" ? "no suffix" : `\`${lane}\``;
                advisories.push({ at: index, error: new PlurnkParseError(
                    entry.line,
                    0,
                    "parser",
                    `${entry.count} OP-shaped ${plural} (${[...entry.ops].join(", ")}) carrying ${shown} were taken as body text of ${statement.op}${lane}; this turn's lane is ${laneShown}, and only headings carrying it are operations.`,
                    "warning",
                ) });
            }
        });
        // Splice from the end so earlier indices stay valid; an advisory follows its statement.
        for (const { at, error } of advisories.toReversed()) items.splice(at + 1, 0, { kind: "error", error });
    }

    // {§scope-slot-tolerance} — `### COPY_ (worker:///src.md<2,3>)`: the line scope was written inside
    // the path slot. `<` and `>` are not URI characters, so a `<...>` right before a slot's closing
    // paren can only be a scope: the heading is read as `(worker:///src.md) <2,3>` and the slip is a
    // warning advisory after its statement — the statement runs (#442, ruled 2026-08-30: accept with a
    // warning). The rewrite adds one character per slot, so a column on the same heading after the
    // slot is off by that much; lines stay true.
    static readonly #SCOPE_SLOT = /\(([^\s()<>]+)<([^<>()\s]+)>\)/g;
    static #tolerateScopeSlots(input: string): { source: string; tolerated: readonly { line: number; column: number; scope: string }[] } {
        const tolerated: { line: number; column: number; scope: string }[] = [];
        const source = input.split("\n").map((text, index) => {
            if (!/^#{2,3} [A-Z]+[A-Za-z0-9_]* /.test(text)) return text;
            return text.replace(PlurnkParser.#SCOPE_SLOT, (match: string, path: string, scope: string, offset: number) => {
                tolerated.push({ line: index + 1, column: offset + path.length + 2, scope });
                return `(${path}) <${scope}>`;
            });
        }).join("\n");
        return { source, tolerated };
    }
    static #scoldScopeSlots(items: ParseItem<any>[], tolerated: readonly { line: number; column: number; scope: string }[]): void {
        // Each scold splices in right after its statement; reversed, two slips on one heading
        // keep their authored order.
        for (const { line, column, scope } of tolerated.toReversed()) {
            const scold: ParseItem<any> = {
                kind: "error",
                error: new PlurnkParseError(
                    line,
                    column,
                    "parser",
                    `\`<${scope}>\` belongs after the \`(path)\` slot, not inside it - \`(path) <${scope}>\` was used.`,
                    "warning",
                ),
            };
            const at = items.findIndex((item) => item.kind === "statement" && (item.statement as { position?: { line: number } }).position?.line === line);
            if (at === -1) items.push(scold);
            else items.splice(at + 1, 0, scold);
        }
    }
    // Terminal disposition alphabet. {§waitpid-dispositions} {§wait-obligation-matrix}

    // Replace ANTLR's generic structure errors with the exact envelope default when the
    // canonical PLAN...SEND shape is cleanly incomplete. The parser admits the useful
    // operations and core records this hard diagnostic as the turn's strike. {§turn-shape}
    static #imperativeTurnShape(items: ParseItem<any>[], input: string): void {
        // {§turn-shape} — PLAN is a SHOULD; only the terminal SEND is structural. A
        // recipient SEND does not satisfy it ({§send-label}).
        const hasSend = items.some(
            (i: any) => i.kind === "statement" && i.statement.op === "SEND" && i.statement.status !== null,
        );
        if (hasSend) return;
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
        // Only add the anchor imperative when the shape is CLEANLY incomplete. If a bounded lexer
        // or visitor error is present, the turn derailed within an operation, so the
        // missing PLAN/SEND is a parse artifact, not the real fix - that specific bounded error
        // is the actionable guidance, and an imperative would mislead.
        const hasSpecificError = items.some(
            (i) => i.kind === "error" && i.error.severity === "error" && i.error.source !== "parser",
        );
        if (hasSpecificError) return;
        if (!hasSend) {
            const position = {
                line: input.split("\n").length,
                column: [...input.slice(input.lastIndexOf("\n") + 1)].length,
            };
            const delimiter = statements[0]?.delimiter ?? "_";
            items.push({
                kind: "error",
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    // {§turn-shape} — the turn ended without its terminal SEND; say what was added and why
                    // the lane matters, without inviting the model to change lanes (#574).
                    `The turn ended without a terminal SEND in its lane ${JSON.stringify(delimiter)}; parser appended \`### SEND${delimiter} (NEXT)\`. Every OP of a turn shares that one lane; end the turn with \`### SEND${delimiter} (NEXT|WAIT|TERM|FAIL)\`.`,
                    "error",
                    PlurnkParser.MISSING_SEND,
                ),
            });
        }
    }

    // {§disposition-ends-turn} — the disposition SEND and its body end the turn. A rail that keeps
    // generating past them wrote the next packet it expected and answered it (2026-09-08: 194, 434,
    // and 35 repeated statements after a correct disposition, each executed, each a receipt row);
    // nothing after the disposition is admitted. The statements are dropped, never executed, and
    // the packet carries ONE hard diagnostic that counts them by OP and states the rule. Bounded
    // diagnostics positioned after the disposition are about that dropped source and collapse into
    // it; a second disposition stays the structural error it always was. parseLog is untouched:
    // saved turns retain trailing operations as authored, so earlier history stays readable.
    static readonly #DISPOSITION_LABEL: Record<number, string> = { 102: "NEXT", 200: "TERM", 202: "WAIT", 499: "FAIL" };
    static #dispositionEndsTurn(items: ParseItem<PlurnkStatement>[]): void {
        const at = items.findIndex((item) => item.kind === "statement" && item.statement.op === "SEND" && item.statement.status !== null);
        if (at === -1) return;
        const disposition = (items[at] as { statement: PlurnkStatement & { status: number; delimiter: string; position: Position } }).statement;
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
        const heading = `### SEND${disposition.delimiter} (${PlurnkParser.#DISPOSITION_LABEL[disposition.status] ?? disposition.status})`;
        kept.push({
            kind: "error",
            error: new PlurnkParseError(
                anchor?.line ?? disposition.position.line,
                anchor?.column ?? 0,
                "parser",
                `The disposition \`${heading}\` ended the turn; ${parts.join(" and ")}. Every OP, including KILL, precedes the disposition SEND.`,
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
        const delimiter = sourceStatements[0]?.delimiter ?? "_";
        const hasTerminalSend = sourceStatements.some(
            (statement) => statement.op === "SEND" && statement.status !== null,
        );
        if (!hasTerminalSend) {
            const send: SendStatement = {
                op: "SEND",
                delimiter,
                annotation: null,
                status: 102,
                target: null,
                metadata: null,
                lineMarker: null,
                body: null,
                position: UNKNOWN_POSITION,
            };
            const lastStatement = items.findLastIndex((item) => item.kind === "statement");
            items.splice(lastStatement + 1, 0, { kind: "statement", statement: send });
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

    // Parse saved turns in source order; PLAN separates them. Each turn
    // requires a disposition, including when ordinary operations follow it.
    static parseLog(input: string): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.log(), undefined, true);
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
        savedLog = false,
    ): ParseResult<S> {
        const lexer = new plurnkLexer(CharStream.fromString(input));
        lexer.savedLog = savedLog;
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
                    `\`${note.heading}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the OP heading line.`,
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
        // EOF concludes a section body and may directly conclude a bodyless
        // heading. Only a partially open modifier destroys the later boundary.
        const modeName = lexer.modeNames[lexer.mode] ?? "";
        if (lexer.mode === 0 || modeName === "BODY" || modeName === "SLOTS") return undefined;
        const openTag = lexer.getOpenTag();
        const from = { line: lexer.getOpenTagLine(), column: lexer.getOpenTagColumn() };
        const heading = lexer.getOpenHeading() || `## ${openTag}`;
        const reason = modeName === "METADATA"
            ? `metadata modifier of \`${heading}\` opened at line ${from.line} but never closed - add \`}\``
            : `target slot of \`${heading}\` opened at line ${from.line} but never closed - add \`)\``;
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
                    // PLAN slot the parser opened then failed to fill on bare text): zero tokens
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
