import { CharStream, CommonTokenStream, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type ClientStatementContext } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import PlurnkParseError from "./PlurnkParseError.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import TagSignal from "./TagSignal.ts";
import {
    UNKNOWN_POSITION,
    type ClientStatement,
    type ParseItem,
    type ParseResult,
    type PlanStatement,
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
    static readonly MISSING_PLAN = "No valid leading PLAN was parsed; an empty `# PLAN0` was used.";
    static readonly MISSING_SEND = "No valid terminal SEND was parsed; `## SEND0 [102]` was used.";
    static readonly NO_VALID_OPERATION = "no valid Plurnk operation was found.";

    // Parse one model turn. Canonical PLAN/SEND framing stays strict in teaching and
    // generation; a source operation lets ingestion recover either omitted boundary.
    // Tolerated preamble TEXT remains an ordered item without language semantics. {§turn-shape}
    static parse(input: string): ParseResult {
        const tagged = PlurnkParser.#tolerateTagSlots(input);
        const { source, tolerated: scoped } = PlurnkParser.#tolerateScopeSlots(tagged.source);
        const result = PlurnkParser.#run(source, (parser) => parser.document());
        PlurnkParser.#scoldTagSlots(result.items, tagged.tolerated);
        PlurnkParser.#scoldScopeSlots(result.items, scoped);
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        PlurnkParser.#flagMisplacedTarget(result.items);
        if (result.unparsedTail === undefined) {
            PlurnkParser.#imperativeTurnShape(result.items);
            PlurnkParser.#imperativeMidTermination(result.items);
            PlurnkParser.#recoverTurnEnvelope(result.items);
        }
        return result;
    }

    // {§tag-slot-tolerance} — `## OP0 (+tag) (path)`: the tag was written in the path slot ahead
    // of the real path. The heading is read as `[+tag] (path)` — same length, so every later
    // position stays true — and the slip is an error row on the heading (#425 F2, ruled
    // 2026-08-29: tolerate and scold). A heading that already carries a signal is not rewritten.
    static readonly #TAG_SLOT = /^(#{1,2} [A-Z]+[A-Za-z0-9_]*) \(([+-][^\s/.*?()[\]{}]+(?:,[+-][^\s/.*?()[\]{}]+)*)\) \(/;

    static #tolerateTagSlots(input: string): { source: string; tolerated: readonly { line: number; column: number; tags: string }[] } {
        const tolerated: { line: number; column: number; tags: string }[] = [];
        const source = input.split("\n").map((text, index) => text.replace(PlurnkParser.#TAG_SLOT, (_, heading: string, tags: string) => {
            tolerated.push({ line: index + 1, column: heading.length + 1, tags });
            return `${heading} [${tags}] (`;
        })).join("\n");
        return { source, tolerated };
    }

    static #scoldTagSlots(items: ParseItem<any>[], tolerated: readonly { line: number; column: number; tags: string }[]): void {
        for (const { line, column, tags } of tolerated) {
            const scold: ParseItem<any> = {
                kind: "error",
                error: new PlurnkParseError(
                    line,
                    column,
                    "parser",
                    `\`(${tags})\` is not a path - a tag rides in the signal slot \`[${tags}]\`; \`(...)\` is the one path slot. \`[${tags}]\` was used.`,
                ),
            };
            const at = items.findIndex((item) => item.kind === "statement" && (item.statement as { position?: { line: number } }).position?.line === line);
            if (at === -1) items.push(scold);
            else items.splice(at + 1, 0, scold);
        }
    }

    // {§scope-slot-tolerance} — `## COPY0 (worker:///src.md<2,3>)`: the line scope was written inside
    // the path slot. `<` and `>` are not URI characters, so a `<...>` right before a slot's closing
    // paren can only be a scope: the heading is read as `(worker:///src.md) <2,3>` and the slip is a
    // warning advisory after its statement — the statement runs (#442, ruled 2026-08-30: accept with a
    // warning). The rewrite adds one character per slot, so a column on the same heading after the
    // slot is off by that much; lines stay true.
    static readonly #SCOPE_SLOT = /\(([^\s()<>]+)<([^<>()\s]+)>\)/g;
    static #tolerateScopeSlots(input: string): { source: string; tolerated: readonly { line: number; column: number; scope: string }[] } {
        const tolerated: { line: number; column: number; scope: string }[] = [];
        const source = input.split("\n").map((text, index) => {
            if (!/^#{1,2} [A-Z]+[A-Za-z0-9_]* /.test(text)) return text;
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
    static #DISPOSITIONS = new Set([102, 200, 202, 499]);

    // Replace ANTLR's generic structure errors with the exact envelope default when the
    // canonical PLAN...SEND shape is cleanly incomplete. The parser admits the useful
    // operations and core records this hard diagnostic as the turn's strike. {§turn-shape}
    static #imperativeTurnShape(items: ParseItem<any>[]): void {
        const hasPlan = items.some((i: any) => i.kind === "statement" && i.statement.op === "PLAN");
        // A mid-comms SEND does not satisfy the terminal requirement.
        const hasSend = items.some(
            (i: any) => i.kind === "statement" && i.statement.op === "SEND" && PlurnkParser.#DISPOSITIONS.has(i.statement.signal),
        );
        if (hasPlan && hasSend) return;
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
        if (!hasPlan) {
            const position = statements[0]?.position ?? UNKNOWN_POSITION;
            items.push({
                kind: "error",
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    PlurnkParser.MISSING_PLAN,
                ),
            });
        }
        if (!hasSend) {
            const position = statements.at(-1)?.position ?? UNKNOWN_POSITION;
            items.push({
                kind: "error",
                error: new PlurnkParseError(
                    position.line,
                    position.column,
                    "parser",
                    PlurnkParser.MISSING_SEND,
                ),
            });
        }
    }

    // A model emission with at least one valid operation remains a useful program when it
    // omits envelope ceremony. Materialize the exact language defaults in the AST; the raw
    // source remains untouched as forensic turnOps evidence. GBNF and parseLog stay strict.
    static #recoverTurnEnvelope(items: ParseItem<PlurnkStatement>[]): void {
        const sourceStatements = items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (sourceStatements.length === 0) return;
        const delimiter = sourceStatements[0]?.delimiter || "0";
        const hasPlan = sourceStatements.some(({ op }) => op === "PLAN");
        const hasTerminalSend = sourceStatements.some(
            (statement) => statement.op === "SEND"
                && typeof statement.signal === "number"
                && PlurnkParser.#DISPOSITIONS.has(statement.signal),
        );
        if (!hasPlan) {
            const plan: PlanStatement = {
                op: "PLAN",
                delimiter,
                annotation: null,
                signal: null,
                target: null,
                metadata: null,
                lineMarker: null,
                body: [],
                position: UNKNOWN_POSITION,
            };
            const firstStatement = items.findIndex((item) => item.kind === "statement");
            items.splice(firstStatement, 0, { kind: "statement", statement: plan });
        }
        if (!hasTerminalSend) {
            const send: SendStatement = {
                op: "SEND",
                delimiter,
                annotation: null,
                signal: 102,
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

    // Lift the mid-turn-termination error. A disposition-coded SEND
    // (102/200/202/499) ends the turn, so a following operation is an error.
    // Rewrite ANTLR's generic structure message to that rule. {§send-mid-reservation}
    // Runs after the begin/end imperative (which handles the incomplete-shape case and, for a
    // complete-but-trailing turn, returns early leaving this error in place to rewrite).
    static #imperativeMidTermination(items: ParseItem<any>[]): void {
        // If a bounded lexer/visitor error derailed the turn, any recovered disposition SEND is
        // suspect; don't mislabel its fallout as a mid-termination. Boundary loss never reaches
        // this pass. Mirrors #imperativeTurnShape's guard.
        if (items.some((i: any) => i.kind === "error" && i.error.severity === "error" && i.error.source !== "parser")) return;
        const terminal = items.find(
            (i: any) => i.kind === "statement" && i.statement.op === "SEND" && PlurnkParser.#DISPOSITIONS.has(i.statement.signal),
        ) as any;
        if (!terminal) return;
        const t = terminal.statement.position;
        for (const i of items as any[]) {
            if (i.kind !== "error" || i.error.source !== "parser" || i.error.severity !== "error") continue;
            const after = i.error.line > t.line || (i.error.line === t.line && i.error.column > t.column);
            if (!after) continue;
            i.error = new PlurnkParseError(
                i.error.line,
                i.error.column,
                "parser",
                "`## SEND0 [submit code]` ends the turn - nothing may follow it",
            );
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

    // Parse a multi-turn LOG - a saved sequence of turns, each a full PLAN-anchored sandwich.
    // Items are flat across turns, in source order; turn
    // boundaries are recoverable from the terminal SENDs. A log is valid (no error items, no
    // unparsedTail) iff every turn in it is a valid turn.
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
        const reason = modeName === "SIGNAL_TAGS" || modeName === "SIGNAL_INT" || modeName === "SIGNAL_IDENT"
            ? `signal slot of \`${heading}\` opened at line ${from.line} but never closed - add \`]\``
            : modeName === "METADATA"
                ? `metadata modifier of \`${heading}\` opened at line ${from.line} but never closed - add \`}\``
            : `target slot of \`${heading}\` opened at line ${from.line} but never closed - add \`)\``;
        return { from, reason };
    }

    // Mutating ops that require a `(target)` and carry a `[tags]` string-array signal. A null target
    // on one of these is unambiguously wrong - there is nothing to edit/copy/move.
    static #MUTATING_OPS = new Set(["EDIT", "COPY", "MOVE"]);

    // A null mutation target plus a path-shaped tag is the narrow advisory gate; an
    // ordinary additive-tag use is not redirected. {§misplaced-target-advisory}
    static #flagMisplacedTarget(items: ParseItem<any>[]): void {
        const pathShaped = (s: string) => s.includes("/") || /[^/]\.[a-zA-Z][a-zA-Z0-9]*$/.test(s);
        const additions: { at: number; item: ParseItem<any> }[] = [];
        items.forEach((item, idx) => {
            if (item.kind !== "statement") return;
            const st: any = item.statement;
            if (!PlurnkParser.#MUTATING_OPS.has(st.op) || st.target !== null) return;
            if (!Array.isArray(st.signal)) return;
            const path = TagSignal.applied(st.signal).add.find(pathShaped);
            if (!path) return;
            additions.push({
                at: idx,
                item: {
                    kind: "error",
                    error: new PlurnkParseError(
                        st.position.line,
                        st.position.column,
                        "parser",
                        `\`## ${st.op}${st.delimiter}\` has no \`(target)\` - that path sits in the \`[…]\` tag slot; a target goes in \`(…)\`. Try \`## ${st.op}${st.delimiter || "0"} (${path})\``,
                        "warning",
                    ),
                },
            });
        });
        for (const { at, item } of additions.reverse()) items.splice(at + 1, 0, item);
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
                    // matched, so its OPEN terminal is null and building it would null-deref.
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
