import { CharStream, CommonTokenStream, ListTokenSource, ParserRuleContext, TerminalNode, Token } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import HeadingReader from "./HeadingReader.ts";
import HeadingTokens from "./HeadingTokens.ts";
// The contexts AstBuilder builds statements from: the statement rules the walk recognizes by rule index.
type BuildContext = Parameters<typeof AstBuilder.build>[0];
import { formatHeadingNotation } from "./MatcherSyntax.ts";
import NativeToolCalls from "./NativeToolCalls.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import { isReasoningOperation, type ReasoningOperation } from "./ReasoningOperation.ts";
import {
    PlurnkParseError,
    type ParseAttempt,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
    type ResourceSelection, isPlurnkOp, writtenOp,
} from "@plurnk/plurnk-contracts";

// Statement-bearing contexts the extraction builds into items. `statement` (statementSeq) and
// `midStatement` (mid-turn ops) each wrap one op; the turn disposition attaches as a direct
// `dispositionStatement` child of a turn.
const STATEMENT_RULES = new Set<number>([
    plurnkParser.RULE_statement,
    plurnkParser.RULE_midStatement,
    plurnkParser.RULE_dispositionStatement,
]);

// One-turn containers, flattened in source order for model and saved programs.
const CONTAINER_RULES = new Set<number>([
    plurnkParser.RULE_modelTurn,
]);

export interface ParseOptions {
    // {§fence-pairing}: the host's vocabulary also permits slotless headings and canonicalizes spelling.
    readonly executors?: readonly string[];
    // {§fence-pairing}: whether a runtime's body is well-formed in the media type it declares.
    readonly wellFormed?: (runtime: string, body: string) => boolean;
}

export default class PlurnkParser {
    static readonly NO_VALID_OPERATION = "No valid Operation Syntax OPs detected.";

    // {§fence-pairing} — canonical framing is wider than any backtick run in the body, so an
    // arbitrary, even unfinished, example survives reparse as body ({§operation-fences}).
    static frame(header: string, body: string | null): string {
        const longest = (body?.match(/`+/g) ?? []).reduce((maximum, ticks) => Math.max(maximum, ticks.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `${fence}${header}\n${body === null ? "" : `${body}\n`}${fence}`;
    }

    // {§fence-pairing} — one statement's heading in canonical slot order, without a fence.
    static heading(statement: PlurnkStatement): string {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the statement without its body is the same op; the union's spread cannot say so
        const [first] = PlurnkParser.stringify([{ ...statement, body: null } as PlurnkStatement]).split("\n");
        return (first ?? "").replace(/^`+/u, "");
    }

    // {§fence-pairing} — framing is syntax, never persisted AST state.
    static stringify(statements: readonly PlurnkStatement[]): string {
        return statements.map((statement) => {
            const name = writtenOp(statement);
            const modifiers: string[] = [];
            // {§parse-recovery} — a lifted matcher is written back bare on the heading line.
            const metadataOf = (metadata: readonly string[] | null | undefined, matcher: { raw: string } | null | undefined, bare: boolean): string[] => {
                const blocks = metadata?.map((block) => `[${block}]`) ?? [];
                if (!bare || matcher === null || matcher === undefined) return blocks;
                return [...blocks, matcher.raw];
            };
            // {§op-shapes} — a bare path renders its channel back as `#channel`.
            const spelled = (target: { kind: string; raw: string; fragment?: string | null }): string =>
                target.kind === "local" && target.fragment !== undefined && target.fragment !== null ? `${target.raw}#${target.fragment}` : target.raw;
            const selection = (resource: ResourceSelection): void => {
                modifiers.push(`(${spelled(resource.target)})`);
                if (resource.lineMarker !== null) modifiers.push(`<${resource.lineMarker.marks.join(",")}>`);
                modifiers.push(...metadataOf(resource.metadata, resource.matcher, false));
            };
            if (statement.op === "COPY" || statement.op === "MOVE") {
                selection(statement.source);
                selection(statement.destination);
            } else {
                if (statement.target !== null) {
                    modifiers.push(`(${spelled(statement.target)})`);
                }
                if (statement.lineMarker !== null) modifiers.push(`<${statement.lineMarker.marks.join(",")}>`);
                if (statement.op === "WAIT" && statement.seconds !== null) modifiers.push(`[${statement.seconds}]`);
                modifiers.push(...metadataOf(statement.metadata, "matcher" in statement ? statement.matcher : null, true));
            }
            if (statement.aside !== null) modifiers.push(`<!-- ${statement.aside} -->`);
            const body = statement.op === "COPY" || statement.op === "MOVE" || statement.body === null ? null
                : typeof statement.body === "string" ? statement.body : statement.body.raw;
            const header = `${name}${modifiers.length === 0 ? "" : ` ${modifiers.join(" ")}`}`;
            return PlurnkParser.frame(header, body);
        }).join("\n\n");
    }

    // {§fence-pairing} {§fence-pairing} the markup lines that sit inside a Markdown quotation:
    // quotation is judged with the markup itself blanked, so its own fence lines quote nothing.
    static #quotedMarkup(input: string, executors: readonly string[]): Set<number> {
        const markup = NativeToolCalls.markupLines(input);
        if (markup.size === 0) return markup;
        const blanked = input.split("\n").map((line, index) => markup.has(index) ? "" : line).join("\n");
        const lexer = new plurnkLexer(CharStream.fromString(blanked));
        for (const name of executors) lexer.knownExecutors.add(name);
        lexer.removeErrorListeners();
        lexer.getAllTokens();
        const points = Array.from(blanked);
        const lineOf: number[] = [];
        let line = 0;
        for (const point of points) { lineOf.push(line); if (point === "\n") line += 1; }
        const quoted = new Set<number>();
        for (const { start, end } of lexer.takeQuotedSpans(points.length)) {
            for (let index = start; index < end; index += 1) if (markup.has(lineOf[index])) quoted.add(lineOf[index]);
        }
        return quoted;
    }

    // Parse one model turn. WAIT may sit anywhere ({§op-shapes}); the runtime settles it last.
    // Outside text is returned separately from executable operations. {§whitespace-contract}
    static parse(input: string, options: ParseOptions = {}): ParseResult {
        const direct = PlurnkParser.#parseTurn(input, options);
        // {§fence-pairing} — an emission with no operation may be native tool-call markup that
        // names plurnk operations; read it as those operations, silently (#760).
        const executors = options.executors ?? [];
        const rewritten = direct.items.some((item) => item.kind === "statement") ? null
            : NativeToolCalls.rewrite(input, executors, PlurnkParser.#quotedMarkup(input, executors));
        if (rewritten !== null) {
            const native = PlurnkParser.#parseTurn(rewritten, options);
            if (native.items.some((item) => item.kind === "statement") && !native.items.some((item) => item.kind === "error" && item.error.severity === "error")) return native;
        }
        // {§fence-pairing} — markup that could not be read is named, with the form that runs.
        const unread = direct.items.flatMap((item) => {
            if (item.kind !== "text") return [];
            const found = NativeToolCalls.unread(item.content, executors, PlurnkParser.#quotedMarkup(item.content, executors));
            return found === null ? [] : [{
                ...found, line: item.position.line + found.line - 1,
                column: found.column + (found.line === 1 ? item.position.column : 0),
            }];
        })[0];
        if (unread === undefined) return direct;
        const absence = (item: ParseItem): boolean => item.kind === "error" && item.error.message === PlurnkParser.NO_VALID_OPERATION;
        const receipt: ParseItem = {
            kind: "error",
            error: new PlurnkParseError(unread.line, unread.column, "parser",
                `\`${unread.markup}\` is tool-call markup and was not executed. Use ${unread.form}.`, "warning", undefined, true),
        };
        return { ...direct, items: [...direct.items.filter((item) => !absence(item)), receipt, ...direct.items.filter(absence)] };
    }

    static #parseTurn(input: string, options: ParseOptions): ParseResult {
        const { result } = PlurnkParser.#run(input, (parser) => parser.document(), undefined, options, "model");
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        if (result.unparsedTail === undefined) PlurnkParser.#requireSourceOperation(result.items);
        return result;
    }

    // {§op-shapes} — only closed top-level operations cross this boundary.
    static parseReasoningOperations(input: string, onAdvisory?: (advisory: PlurnkParseError) => void): ReasoningOperation[] {
        const warnings = new Map<PlurnkStatement, PlurnkParseError[]>();
        const { result, lexer } = PlurnkParser.#run(input, (parser) => parser.statementSeq(), (ctx, spellings) => {
            const built = AstBuilder.build(ctx, spellings);
            if (built.statements[0] !== undefined) warnings.set(built.statements[0], built.advisories);
            return built;
        }, {}, "reasoning");
        const reasoning = (statement: PlurnkStatement): statement is ReasoningOperation => isReasoningOperation(statement.op);
        const operations = result.items.flatMap((item) => item.kind === "statement"
            && reasoning(item.statement)
            && lexer.hasClosedBlock(item.statement.position.line)
            ? [item.statement] : []);
        for (const operation of operations) {
            for (const warning of warnings.get(operation) ?? []) onAdvisory?.(warning);
        }
        return operations;
    }

    // {§whitespace-contract} — no source operation is reported as its own fact, beside every diagnostic
    // that explains it: a host admits a turn whose only diagnostic is this one as an empty turn
    // ({§outside-text}) and rejects one that also carries a malformed heading.
    static #requireSourceOperation(items: ParseItem[]): void {
        if (items.some((item) => item.kind === "statement")) return;
        // The grammar's end-of-input complaint only restates the absence; specific diagnostics
        // (an unclosed slot, a stray character) stay, so the host can tell prose from a malformed heading.
        const restatesAbsence = (item: ParseItem): boolean =>
            item.kind === "error" && item.error.source === "parser" && item.error.message.startsWith("unexpected end of input");
        const kept = items.filter((item) => !restatesAbsence(item));
        items.length = 0;
        items.push(...kept);
        const anchor = items.find((i): i is Extract<ParseItem, { kind: "error" }> => i.kind === "error" && i.error.severity === "error")?.error;
        items.push({
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
    // documentation snippets. No turn shape; outside text is ignored in this tier.
    // Not for model output; use `parse` for that.
    static parseStatements(input: string, options: ParseOptions = {}): ParseResult {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq(), undefined, options).result;
    }

    static #run(
        input: string,
        parseFn: (parser: plurnkParser) => ParserRuleContext,
        buildFn: (ctx: BuildContext, spellings: ReadonlyMap<string, string>) => { statements: PlurnkStatement[]; advisories: PlurnkParseError[] } = (ctx, spellings) => AstBuilder.build(ctx, spellings),
        options: ParseOptions = {},
        tier: "statements" | "model" | "reasoning" = "statements",
    ): { result: ParseResult; lexer: plurnkLexer } {
        const lexer = new plurnkLexer(CharStream.fromString(input));
        lexer.reasoning = tier === "reasoning";
        lexer.wellFormed = options.wellFormed;
        const spellings = HeadingReader.executorSpellings(lexer.knownExecutors, options.executors);
        const errors: PlurnkParseError[] = [];
        lexer.removeErrorListeners();
        lexer.addErrorListener(new RecordingListener("lexer", errors));

        // {§fence-pairing} — lex eagerly so heading near-misses can be put in canonical order.
        const tokens = lexer.getAllTokens();
        const tokenStream = new CommonTokenStream(new ListTokenSource(HeadingTokens.normalize(tokens)));
        const parser = new plurnkParser(tokenStream);
        parser.removeErrorListeners();
        parser.addErrorListener(new RecordingListener("parser", errors));
        parser.errorHandler = new PlurnkErrorStrategy();

        const tree = parseFn(parser);
        PlurnkParser.#dedupeLexerCascade(errors);
        const unparsedTail = PlurnkParser.#unparsedTail(lexer);

        const items: ParseItem[] = [];
        const consumedErrors = new Set<PlurnkParseError>();
        PlurnkParser.#collect(tree, errors, consumedErrors, items, buildFn, spellings, unparsedTail?.from);
        // {§parse-recovery} — the log's heading notation was read as the slot it stands for; each reading is
        // named once, right after its statement, with the form to write. A statement that was not built draws none.
        const named = new Set<string>();
        for (const note of lexer.takeHeadingNotations()) {
            const at = items.findIndex((item) => item.kind === "statement" && item.statement.position.line === note.line);
            if (at === -1) continue;
            const found = items[at];
            if (found.kind !== "statement") continue;
            const { statement } = found;
            const message = formatHeadingNotation(note, statement, PlurnkParser.heading);
            // COPY and MOVE show both operands in one corrected line: say it once.
            const key = `${note.line}|${note.kind === "arrow" ? note.kind : message}`;
            if (named.has(key)) continue;
            named.add(key);
            items.splice(at + 1, 0, { kind: "error", error: new PlurnkParseError(note.line, note.column, "parser", message, "warning") });
        }

        for (const err of errors) {
            if (!consumedErrors.has(err)
                && (unparsedTail === undefined || PlurnkParser.#isBefore(err, unparsedTail.from))) {
                items.push({ kind: "error", error: err });
            }
        }
        // {§fence-pairing} — the aside ran to the end of the line; say so once.
        for (const note of lexer.takeUnclosedAsides()) {
            items.push({
                kind: "error",
                error: new PlurnkParseError(note.line, note.column, "parser",
                    "The aside was not closed with `-->`; it was read to the end of the line.", "warning"),
            });
        }
        // {§fence-pairing} — an operation inside an unlabeled code block was shown, never run; say so once.
        for (const note of lexer.takeQuotedTags()) {
            items.push({ kind: "error", error: new PlurnkParseError(note.line, note.column, "parser", `\`${note.tag}\` inside a code block was shown, not run.`, "warning") });
        }
        // {§fence-pairing} — the operation ran; its opener spanned two lines, so say how it is written once.
        for (const note of lexer.takeForgottenTags()) {
            items.push({ kind: "error", error: new PlurnkParseError(note.line, note.column, "parser", `\`${note.tag}\` ran, though its fence was malformed: the opening fence, OP, parameters, and aside share one line.`, "warning") });
        }

        if (tier === "model") {
            // {§whitespace-contract}: the line that wrote an operation without its fence is a broken
            // program, not response text — it draws its warning and never becomes narration.
            const unfenced = PlurnkParser.#unfencedOperations(tokens, lexer.takeQuotedSpans(lexer.inputStream.size), lexer.knownExecutors, unparsedTail?.from);
            items.push(...PlurnkParser.#responseText(tokens, new Set(unfenced.map(({ line }) => line)), unparsedTail?.from));
            items.push(...unfenced.map(({ item }) => item));
            const position = (item: ParseItem): Position => item.kind === "statement" ? item.statement.position
                : item.kind === "text" ? item.position : item.error;
            items.sort((a, b) => position(a).line - position(b).line || position(a).column - position(b).column);
        }
        return { result: { items, unparsedTail }, lexer };
    }

    // {§whitespace-contract}: only the lexer's outside-text channel is recoverable; a malformed
    // operation remains an operation region even when it produces no AST statement.
    // `excludedLines` are the unfenced operation lines ({§whitespace-contract}): the whole line, operand included.
    static #responseText(tokens: readonly Token[], excludedLines: ReadonlySet<number>, boundary?: Position): Extract<ParseItem, { kind: "text" }>[] {
        const items: Extract<ParseItem, { kind: "text" }>[] = [];
        let content = "";
        let position: Position | null = null;
        const flush = (): void => {
            if (position !== null && content.trim() !== "") items.push({ kind: "text", content, position });
            content = "";
            position = null;
        };
        for (const token of tokens) {
            if (boundary !== undefined && !PlurnkParser.#isBefore(token, boundary)) break;
            if (token.type !== plurnkLexer.TEXT && token.type !== plurnkLexer.WS) {
                flush();
                continue;
            }
            if (excludedLines.has(token.line)) {
                flush();
                continue;
            }
            position ??= { line: token.line, column: token.column };
            content += token.text ?? "";
        }
        flush();
        return items;
    }

    // {§whitespace-contract}: name the ignored fragment, not the outcome of fenced operations
    // elsewhere in the turn. A name with only an optional aside is opened by the lexer
    // ({§operation-fences}); executor names require an operand slot, since `sh`, `env` and
    // `members` can also be ordinary words.
    static #unfencedOperations(tokens: readonly Token[], quoted: ReadonlyArray<{ start: number; end: number }>, executors: ReadonlySet<string>, boundary?: Position): Array<{ line: number; item: Extract<ParseItem, { kind: "error" }> }> {
        const items: Array<{ line: number; item: Extract<ParseItem, { kind: "error" }> }> = [];
        const lower = new Set([...executors].map((name) => name.toLowerCase()));
        for (const [index, token] of tokens.entries()) {
            if (boundary !== undefined && !PlurnkParser.#isBefore(token, boundary)) break;
            if (token.type !== plurnkLexer.TEXT || token.column !== 0) continue;
            if (quoted.some(({ start, end }) => token.start >= start && token.start < end)) continue;
            const native = /^[A-Z]+(?=$|[(<[])/u.exec(token.text ?? "")?.[0];
            const name = isPlurnkOp(native)
                ? native
                : PlurnkParser.#unfencedExecutor(tokens, index, lower);
            if (name === undefined) continue;
            items.push({ line: token.line, item: { kind: "error", error: new PlurnkParseError(token.line, token.column, "parser", `Unfenced \`${name}\` ignored.`, "warning", undefined, true) } });
        }
        return items;
    }

    static #unfencedExecutor(tokens: readonly Token[], index: number, executors: ReadonlySet<string>): string | undefined {
        const token = tokens[index];
        const match = /^([A-Za-z0-9_.+-]+)(\(?)/u.exec(token.text ?? "");
        if (match === null || !executors.has(match[1].toLowerCase())) return undefined;
        if (match[2] === "(") return match[1];
        for (let next = index + 1; next < tokens.length; next += 1) {
            const candidate = tokens[next];
            if (candidate.line !== token.line) return undefined;
            if (candidate.type === plurnkLexer.WS) continue;
            return candidate.type === plurnkLexer.TEXT && (candidate.text ?? "").startsWith("(") ? match[1] : undefined;
        }
        return undefined;
    }

    // Determine the public trust boundary before visiting recovered contexts. The parser may
    // synthesize tree nodes after an unfinished lexer mode, but those nodes have no public AST
    // meaning and can violate AstBuilder's complete-statement precondition. {§parse-recovery}
    static #unparsedTail(lexer: plurnkLexer): ParseResult["unparsedTail"] {
        const modeName = lexer.modeNames[lexer.mode] ?? "";
        // {§operation-fences} — a block still open at the end of the input ended there; only an
        // unfinished target or metadata slot loses the boundary.
        if (modeName !== "TARGET" && modeName !== "METADATA") return undefined;
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
    static #collect(
        ctx: ParserRuleContext,
        errors: PlurnkParseError[],
        consumedErrors: Set<PlurnkParseError>,
        items: ParseItem[],
        buildFn: (ctx: BuildContext, spellings: ReadonlyMap<string, string>) => { statements: PlurnkStatement[]; advisories: PlurnkParseError[] },
        spellings: ReadonlyMap<string, string>,
        boundary?: Position,
    ): void {
        for (const child of ctx.children ?? []) {
            // A child is a rule context or a terminal: the walk reads the fields of whichever it is.
            const rule = child instanceof ParserRuleContext ? child : undefined;
            const symbol = child instanceof TerminalNode ? child.symbol : null;
            const start = rule?.start ?? symbol;
            const stop = rule?.stop ?? symbol;
            if (!start) continue;
            if (boundary !== undefined && !PlurnkParser.#isBefore(start, boundary)) continue;

            if (rule !== undefined && STATEMENT_RULES.has(rule.ruleIndex)) {
                const errorsForStatement = errors.filter(
                    (e) => !consumedErrors.has(e) && PlurnkParser.#errorInRange(e, start, stop ?? start),
                );
                const errForStatement = errorsForStatement[0];
                if (errForStatement) {
                    // One malformed statement projects one hard diagnostic. {§parse-recovery}
                    for (const error of errorsForStatement) consumedErrors.add(error);
                    items.push({ kind: "error", error: errForStatement, ...PlurnkParser.#attempt(start, stop) });
                } else if (rule.getChildCount() === 0 || ("exception" in rule && rule.exception !== null && rule.exception !== undefined) || rule.start?.type === Token.EOF) {
                    // A phantom statement context synthesized during error recovery (a required
                    // slot the parser opened then failed to fill, or a disposition the log rule
                    // demanded at the end of the input): nothing real was matched, so building it
                    // would build the recovery token. Surface the parser's own diagnostic instead.
                    const pending = errors.find((e) => !consumedErrors.has(e) && !PlurnkParser.#isBefore(e, start));
                    if (pending) {
                        consumedErrors.add(pending);
                        items.push({ kind: "error", error: pending });
                    }
                } else {
                    try {
                        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a context whose rule is a statement rule is one of the build contexts
                        const { statements, advisories } = buildFn(rule as BuildContext, spellings);
                        for (const statement of statements) items.push({ kind: "statement", statement });
                        // {§parse-recovery} — the builder's advisories follow their statement.
                        for (const advisory of advisories) items.push({ kind: "error", error: advisory });
                    } catch (e) {
                        // A genuine visitor contract violation (e.g. a malformed URI) is a
                        // PlurnkParseError - surface it as an error item. Anything else is an
                        // internal bug, not a parse error: let it crash rather than masquerade
                        // as a model-facing parse-error item.
                        if (!(e instanceof PlurnkParseError)) throw e;
                        items.push({ kind: "error", error: e, ...PlurnkParser.#attempt(start, stop) });
                    }
                }
            } else if (rule !== undefined && CONTAINER_RULES.has(rule.ruleIndex)) {
                PlurnkParser.#collect(rule, errors, consumedErrors, items, buildFn, spellings, boundary);
            }
        }
    }

    // {§parse-recovery} The statement a hard fact refused: its text as written, and the verb its opening fence names.
    static #attempt(start: Token, stop: Token | null | undefined): { attempt: ParseAttempt } | Record<string, never> {
        const verb = (start.text ?? "").replace(/^`+[0-9]*/u, "").trim();
        const text = start.inputStream?.getTextFromRange(start.start, (stop ?? start).stop);
        return verb.length === 0 || /\s/u.test(verb) || text === undefined ? {} : { attempt: { verb, text } };
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
