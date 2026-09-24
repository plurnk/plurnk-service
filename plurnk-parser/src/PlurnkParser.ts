import { CharStream, CommonTokenStream, ListTokenSource, Token, type ParserRuleContext } from "antlr4ng";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import { plurnkParser, type ClientStatementContext } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import HeadingTokens from "./HeadingTokens.ts";
import NativeToolCalls from "./NativeToolCalls.ts";
import PlurnkErrorStrategy from "./PlurnkErrorStrategy.ts";
import RecordingListener from "./RecordingListener.ts";
import {
    PlurnkParseError,
    type ClientStatement,
    type NoteStatement,
    type ParseItem,
    type ParseResult,
    type PlurnkStatement,
    type Position,
    type ResourceSelection,
} from "@plurnk/plurnk-contracts";
import { PLURNK_OPS, writtenOp } from "@plurnk/plurnk-contracts";

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
]);

// {§fence-heading-in-body} — the host names executors eligible for heading recovery
// when a complete nested block cannot be established ({§balanced-fences}).
export interface ParseOptions {
    readonly executors?: readonly string[];
}

export default class PlurnkParser {
    static readonly NO_VALID_OPERATION = "No valid Operation Syntax OPs detected.";

    // {§statement-rendering} — canonical framing is wider than any backtick run in the body, so an
    // arbitrary, even unfinished, example survives reparse as body ({§balanced-fences}).
    static frame(header: string, body: string | null): string {
        const longest = (body?.match(/`+/g) ?? []).reduce((maximum, ticks) => Math.max(maximum, ticks.length), 0);
        const fence = "`".repeat(Math.max(3, longest + 1));
        return `${fence}${header}\n${body === null ? "" : `${body}\n`}${fence}`;
    }

    // {§log-wire-format} — one statement's heading as written, canonical slot order, no fence: what a
    // log row echoes so the model reads its request back in the syntax it wrote it in.
    static heading(statement: ClientStatement): string {
        const [first] = PlurnkParser.stringify([{ ...statement, body: null } as ClientStatement]).split("\n");
        return (first ?? "").replace(/^`+/u, "");
    }

    // {§statement-rendering} — framing is syntax, never persisted AST state.
    static stringify(statements: readonly ClientStatement[]): string {
        return statements.map((statement) => {
            const name = writtenOp(statement);
            const modifiers: string[] = [];
            // {§naked-pattern} — a lifted matcher is written back bare when the bare form reads back
            // identically; otherwise as its `pattern` option ({§matcher-option}), the escape.
            const naked = (raw: string): boolean => raw.trim() === raw && raw !== "" && !/[\r\n]/u.test(raw) && !raw.includes("<!--")
                && (/^(\/|\$|~|&|\^)/u.test(raw) || ((statement.op === "FIND" || statement.op === "READ" || statement.op === "KILL") && !/^[[(<`]/u.test(raw)));
            const metadataOf = (metadata: readonly string[] | null | undefined, matcher: { raw: string } | null | undefined, bare: boolean): string[] => {
                const blocks = metadata?.map((block) => `[${block}]`) ?? [];
                if (matcher === null || matcher === undefined) return blocks;
                const options = AstBuilder.metadataOptions(metadata);
                if (options?.pattern === matcher.raw) return blocks;
                if (bare && naked(matcher.raw)) return [...blocks, matcher.raw];
                const option = JSON.stringify({ pattern: matcher.raw });
                if (options !== null) return [`[${metadata![0]},${option}]`];
                return [...blocks, `[${option}]`];
            };
            // {§local-path-fragment} — a bare path renders its channel back as `#channel`.
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
                modifiers.push(...metadataOf(statement.metadata, "matcher" in statement ? statement.matcher : null, true));
            }
            if (statement.aside !== null) modifiers.push(`<!-- ${statement.aside} -->`);
            const body = statement.op === "COPY" || statement.op === "MOVE" || statement.body === null ? null
                : typeof statement.body === "string" ? statement.body : statement.body.raw;
            const header = `${name}${modifiers.length === 0 ? "" : ` ${modifiers.join(" ")}`}`;
            return PlurnkParser.frame(header, body);
        }).join("\n\n");
    }

    // {§quotation} {§native-tool-calls} the markup lines that sit inside a Markdown quotation:
    // quotation is judged with the markup itself blanked, so its own fence lines quote nothing.
    static #quotedMarkup(input: string, executors: readonly string[]): Set<number> {
        const markup = NativeToolCalls.markupLines(input);
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
            for (let index = start; index < end; index += 1) if (markup.has(lineOf[index]!)) quoted.add(lineOf[index]!);
        }
        return quoted;
    }

    // Parse one model turn. An omitted disposition is silent continuation; a present one
    // may sit anywhere in the turn ({§disposition-anywhere}) and the runtime executes it last.
    // Outside text is returned separately from executable operations. {§response-text}
    static parse(input: string, options: ParseOptions = {}): ParseResult {
        const direct = PlurnkParser.#parseTurn(input, options);
        if (direct.items.some((item) => item.kind === "statement")) return direct;
        // {§native-tool-calls} — an emission with no operation may be native tool-call markup that
        // names plurnk operations; read it as those operations, silently (#760).
        const executors = options.executors ?? [];
        const rewritten = NativeToolCalls.rewrite(input, executors, PlurnkParser.#quotedMarkup(input, executors));
        if (rewritten === null) return direct;
        const native = PlurnkParser.#parseTurn(rewritten, options);
        return native.items.some((item) => item.kind === "statement") && !native.items.some((item) => item.kind === "error" && item.error.severity === "error")
            ? native
            : direct;
    }

    static #parseTurn(input: string, options: ParseOptions): ParseResult {
        const result = PlurnkParser.#run(input, (parser) => parser.document(), undefined, options, "model");
        // Value-adds layered on ANTLR's diagnostics while the document boundary
        // remains trustworthy. Neither changes what parsed.
        if (result.unparsedTail === undefined) PlurnkParser.#requireSourceOperation(result.items);
        return result;
    }

    // {§reasoning-notes} — reasoning is not a program. Only its admitted top-level NOTE blocks
    // cross this boundary; quoted bodies and all other operations remain reasoning evidence.
    static parseReasoningNotes(input: string): NoteStatement[] {
        return PlurnkParser.#run(input, (parser) => parser.statementSeq(), undefined, {}, "reasoning").items.flatMap((item) =>
            item.kind === "statement" && item.statement.op === "NOTE" ? [item.statement] : []);
    }

    // {§turn-shape} — no source operation is reported as its own fact, beside every diagnostic
    // that explains it: a host admits a turn whose only diagnostic is this one as an empty turn
    // ({§empty-turn}) and rejects one that also carries a malformed heading.
    static #requireSourceOperation(items: ParseItem<PlurnkStatement>[]): void {
        if (items.some((item) => item.kind === "statement")) return;
        // The grammar's end-of-input complaint only restates the absence; specific diagnostics
        // (an unclosed slot, a stray character) stay, so the host can tell prose from a malformed heading.
        const restatesAbsence = (item: ParseItem<PlurnkStatement>): boolean =>
            item.kind === "error" && item.error.source === "parser" && /^unexpected end of input/u.test(item.error.message);
        const kept = items.filter((item) => !restatesAbsence(item));
        items.length = 0;
        items.push(...kept);
        const anchor = (items.find((i) => i.kind === "error" && i.error.severity === "error") as { error: PlurnkParseError } | undefined)?.error;
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
        return PlurnkParser.#run(input, (parser) => parser.statementSeq(), undefined, options);
    }

    // Parse the CLIENT tier - a bare sequence of protocol statements plus the client-only utility
    // op LOOK. The topmost subset (one above Script); never used for model output. The
    // protocol entry points reject LOOK, so a client op only parses here.
    static parseClient(input: string, options: ParseOptions = {}): ParseResult<ClientStatement> {
        return PlurnkParser.#run<ClientStatement>(
            input,
            (parser) => parser.clientStatementSeq(),
            (ctx) => AstBuilder.buildClient(ctx as ClientStatementContext),
            options,
        );
    }

    static #run<S extends ClientStatement = PlurnkStatement>(
        input: string,
        parseFn: (parser: plurnkParser) => ParserRuleContext,
        buildFn: (ctx: any) => S = ((ctx: any) => AstBuilder.build(ctx) as S),
        options: ParseOptions = {},
        tier: "statements" | "model" | "reasoning" = "statements",
    ): ParseResult<S> {
        const lexer = new plurnkLexer(CharStream.fromString(input));
        lexer.reasoning = tier === "reasoning";
        for (const name of options.executors ?? []) lexer.knownExecutors.add(name);
        const spellings = new Map([...lexer.knownExecutors].map((name) => [name.toLowerCase(), name]));
        const node = spellings.get("node");
        if (node !== undefined && !spellings.has("js")) {
            // {§executor-js-spelling}: canonicalize before runtime admission, without another registration.
            lexer.knownExecutors.add("js");
            spellings.set("js", node);
        }
        AstBuilder.executorSpellings = spellings;
        const errors: PlurnkParseError[] = [];
        lexer.removeErrorListeners();
        lexer.addErrorListener(new RecordingListener("lexer", errors));

        // {§heading-slot-order} — lex eagerly so heading near-misses can be put in canonical order.
        const tokens = lexer.getAllTokens();
        const tokenStream = new CommonTokenStream(new ListTokenSource(HeadingTokens.normalize(tokens)));
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
        // {§unclosed-aside} — the aside ran to the end of the line; say so once.
        for (const note of lexer.takeUnclosedAsides()) {
            items.push({
                kind: "error",
                error: new PlurnkParseError(note.line, note.column, "parser",
                    "The aside was not closed with `-->`; it was read to the end of the line.", "warning"),
            });
        }
        // {§quotation} — an operation inside an unlabeled code block was shown, never run; say so once.
        for (const note of lexer.takeQuotedTags()) {
            items.push({ kind: "error", error: new PlurnkParseError(note.line, note.column, "parser", `\`${note.tag}\` inside a code block was shown, not run.`, "warning") });
        }
        // {§quotation} — an unknown tag with a target slot is an operation missed by its tag; say so once.
        for (const note of lexer.takeMissedTags()) {
            items.push({ kind: "error", error: new PlurnkParseError(note.line, note.column, "parser", `\`${note.tag}\` is not an operation or a known executor here.`, "warning") });
        }

        if (tier === "model") {
            // {§unfenced-operation}: the line that wrote an operation without its fence is a broken
            // program, not response text — it draws its warning and never becomes narration.
            const unfenced = PlurnkParser.#unfencedOperations(tokens, lexer.takeQuotedSpans(lexer.inputStream.size), lexer.knownExecutors, unparsedTail?.from);
            items.push(...PlurnkParser.#responseText(tokens, new Set(unfenced.map(({ line }) => line)), unparsedTail?.from));
            items.push(...unfenced.map(({ item }) => item));
            const position = (item: ParseItem<S>): Position => item.kind === "statement" ? item.statement.position
                : item.kind === "text" ? item.position : item.error;
            items.sort((a, b) => position(a).line - position(b).line || position(a).column - position(b).column);
        }
        return { items, unparsedTail };
    }

    // {§response-text}: only the lexer's outside-text channel is recoverable; a malformed
    // operation remains an operation region even when it produces no AST statement.
    // `excludedLines` are the unfenced operation lines ({§unfenced-operation}): the whole line, operand included.
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

    // {§unfenced-operation}: a prose line that opens with an operation's name and anything else
    // wrote the operation without its fence. It did not run, and the model that wrote it believes
    // it did. The bare name alone never reaches here: the lexer opened it ({§naked-operation}).
    // {§unfenced-operation} — a native name opening a column-zero line, or a registered executor's name
    // followed by an operand slot (`gitea (list_issues)`, `sh(build.sh)`); an executor's name inside a
    // sentence is a word, since `sh`, `env` and `members` are English.
    static #unfencedOperations(tokens: readonly Token[], quoted: ReadonlyArray<{ start: number; end: number }>, executors: ReadonlySet<string>, boundary?: Position): Array<{ line: number; item: Extract<ParseItem, { kind: "error" }> }> {
        const items: Array<{ line: number; item: Extract<ParseItem, { kind: "error" }> }> = [];
        const lower = new Set([...executors].map((name) => name.toLowerCase()));
        for (const [index, token] of tokens.entries()) {
            if (boundary !== undefined && !PlurnkParser.#isBefore(token, boundary)) break;
            if (token.type !== plurnkLexer.TEXT || token.column !== 0) continue;
            if (quoted.some(({ start, end }) => token.start >= start && token.start < end)) continue;
            const native = /^[A-Z]+(?=$|[(<[])/u.exec(token.text ?? "")?.[0];
            const name = native !== undefined && (PLURNK_OPS as readonly string[]).includes(native)
                ? native
                : PlurnkParser.#unfencedExecutor(tokens, index, lower);
            if (name === undefined) continue;
            items.push({ line: token.line, item: { kind: "error", error: new PlurnkParseError(token.line, token.column, "parser", `\`${name}\` has no fence, so it did not run.`, "warning") } });
        }
        return items;
    }

    static #unfencedExecutor(tokens: readonly Token[], index: number, executors: ReadonlySet<string>): string | undefined {
        const token = tokens[index]!;
        const match = /^([A-Za-z0-9_.+-]+)(\(?)/u.exec(token.text ?? "");
        if (match === null || !executors.has(match[1]!.toLowerCase())) return undefined;
        if (match[2] === "(") return match[1];
        for (let next = index + 1; next < tokens.length; next += 1) {
            const candidate = tokens[next]!;
            if (candidate.line !== token.line) return undefined;
            if (candidate.type === plurnkLexer.WS) continue;
            return candidate.type === plurnkLexer.TEXT && (candidate.text ?? "").startsWith("(") ? match[1] : undefined;
        }
        return undefined;
    }

    // Determine the public trust boundary before visiting recovered contexts. The parser may
    // synthesize tree nodes after an unfinished lexer mode, but those nodes have no public AST
    // meaning and can violate AstBuilder's complete-statement precondition. {§unparsed-tail-boundary}
    static #unparsedTail(lexer: plurnkLexer): ParseResult["unparsedTail"] {
        const modeName = lexer.modeNames[lexer.mode] ?? "";
        // {§closer-fallback} — a block still open at the end of the input ended there; only an
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
                } else if ((c.getChildCount?.() ?? 0) === 0 || c.exception || c.start?.type === Token.EOF) {
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
                        const { value: statement, advisories } = AstBuilder.collectAdvisories(() => buildFn(c));
                        items.push({ kind: "statement", statement });
                        // {§misplaced-aside-advisory} — the builder's advisories follow their statement.
                        for (const advisory of advisories) items.push({ kind: "error", error: advisory });
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
