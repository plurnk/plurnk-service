import {
    DefaultErrorStrategy,
    InputMismatchException,
    NoViableAltException,
    Token,
    type Parser,
    type RecognitionException,
} from "antlr4ng";
import { plurnkParser } from "./generated/plurnkParser.ts";
import { plurnkLexer } from "./generated/plurnkLexer.ts";

const COMBINED_ANCHOR_LINE_DIAGNOSTIC =
    "a scope position accepts one line coordinate; use the `@hash` anchor without its displayed line number";

export default class PlurnkErrorStrategy extends DefaultErrorStrategy {
    static #OFFENDING_CHAR_RE = /at: '([^']*)'$/;

    static #LEXER_MODE_CONTEXT: Record<string, string> = {
        DEFAULT_MODE: "before the PLAN heading",
        SLOTS: "in operation heading - expected a space before `(path)`, `{metadata}`, or `<scope>`, or a line ending",
        TARGET: "in `(path)` slot - expected URI characters or `)`",
        METADATA: "in `{metadata}` modifier - expected single-line scheme content or `}`",
        BODY: "in body",
    };

    static #SLOT_BY_TOKEN: Record<number, string> = {
        [plurnkParser.OPEN_FIND]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_READ]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_EDIT]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_COPY]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_MOVE]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_SEND]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_EXEC]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_BARE]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_WORK]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_FORK]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_KILL]: "H2 operation heading `## OPdelimiter`",
        [plurnkParser.OPEN_PLAN]: "PLAN heading `# PLANdelimiter`",
        [plurnkParser.OPEN_LOOK]: "H2 client heading `## OPdelimiter`",
        [plurnkParser.OPEN_BUFF]: "H2 client heading `## OPdelimiter`",
        [plurnkParser.LPAREN]: "`(` (`(path)` slot opener)",
        [plurnkParser.RPAREN]: "`)` (`(path)` slot closer)",
        [plurnkParser.LBRACE]: "`{` (`{metadata}` modifier opener)",
        [plurnkParser.RBRACE]: "`}` (`{metadata}` modifier closer)",
        [plurnkParser.L_MARKER]: "`<L>` line marker",
        [plurnkParser.BODY_OPEN]: "operation-heading line ending",
        [plurnkParser.SECTION_END]: "next same-lane heading",
        [plurnkParser.TARGET_TEXT]: "path content",
        [plurnkParser.METADATA_TEXT]: "scheme metadata content",
        [plurnkParser.BODY_TEXT]: "body content",
        [plurnkParser.TEXT]: "text before PLAN",
    };

    static translateLexerMessage(lexer: plurnkLexer, originalMsg: string): string {
        const modeName = lexer.modeNames[lexer.mode] ?? "DEFAULT_MODE";
        const context = PlurnkErrorStrategy.#LEXER_MODE_CONTEXT[modeName] ?? "between statements";
        const ch = PlurnkErrorStrategy.#extractOffendingChar(originalMsg);
        // {§legacy-bracket-slot} — the retired `[signal]` slot gets one bounded redirect to the
        // two forms that replaced it, instead of the generic spacing rule.
        if (modeName === "SLOTS" && ch === "'['" && lexer.getOpenTag().startsWith("PLAN")) {
            return "unrecognized character '[' after PLAN - PLAN takes no modifiers; the Plan body starts on the next line";
        }
        if (modeName === "SLOTS" && ch === "'['") {
            return "unrecognized character '[' in operation heading - the `[...]` slot is retired: a SEND label rides in the path slot `## SEND0 (NEXT)`, an EXEC runtime in its path `## EXEC0 (gitea/list_issues)`";
        }
        // Redirect an unambiguous matcher prefix in the slot region into the body. Slash-led
        // regex and XPath redirect only once the heading has closed a `(target)` — before
        // that, `/` may instead be a target whose `(...)` wrap was omitted. (bench#5 run16/17:
        // the generic message taught models to avoid regex FIND altogether.)
        // A `<…>` slot that opened after its own space is a scope whose CONTENT is wrong —
        // name the shapes the slot admits instead of the spacing rule (#386). A `<` glued to
        // the previous slot keeps the spacing message below.
        if (modeName === "SLOTS" && ch.startsWith("'<") && PlurnkErrorStrategy.#scopeOpenedAfterSpace(lexer)) {
            return `unrecognized scope ${ch} in operation heading - a scope is numeric: \`<L>\`, \`<SL,EL>\`, \`<SL,SC,EL,EC>\`, \`<0>\`, or \`<-1>\`, or anchored: \`<@hash>\`, \`<@start,@end>\`; EXEC's \`<timeout,poll>\` are minutes, e.g. \`<5>\` or \`<5,1>\`; a resource address is never a scope`;
        }
        if (modeName === "SLOTS" && (/^'[$~@]'$/.test(ch)
            || (ch === "'/'" && PlurnkErrorStrategy.#headingClosedTarget(lexer)))) {
            return `unrecognized character ${ch} in operation heading - a matcher is body content, below the OP heading`;
        }
        return `unrecognized character ${ch} ${context}`;
    }

    // True when the nearest `<` on the current heading line follows a space, i.e. the slot
    // was opened as its own slot rather than glued to the previous one.
    static #scopeOpenedAfterSpace(lexer: plurnkLexer): boolean {
        const stream = lexer.inputStream;
        for (let i = Math.min(stream.index, stream.size - 1); i >= 0; i -= 1) {
            const char = stream.getTextFromRange(i, i);
            if (char === "\n") return false;
            if (char === "<") return i > 0 && stream.getTextFromRange(i - 1, i - 1) === " ";
        }
        return false;
    }

    // True when the current heading line already closed a `(...)` target.
    static #headingClosedTarget(lexer: plurnkLexer): boolean {
        const stream = lexer.inputStream;
        for (let i = stream.index - 1; i >= 0; i -= 1) {
            const char = stream.getTextFromRange(i, i);
            if (char === "\n") return false;
            if (char === ")") return true;
        }
        return false;
    }

    static #extractOffendingChar(msg: string): string {
        const m = PlurnkErrorStrategy.#OFFENDING_CHAR_RE.exec(msg);
        if (!m) return "input";
        const text = m[1];
        return text === "" ? "end of input" : `'${text}'`;
    }

    static #describeToken(tok: Token | null): string {
        if (!tok || tok.type === Token.EOF) return "end of input";
        const slot = PlurnkErrorStrategy.#SLOT_BY_TOKEN[tok.type];
        if (slot) return slot;
        const text = tok.text ?? "";
        return text.length > 0 ? `'${text}'` : "input";
    }

    static #describeExpected(e: RecognitionException): string | null {
        const expected = e.getExpectedTokens();
        if (!expected) return null;
        const types: number[] = expected.toArray();
        if (types.length === 0) return null;
        // Every OPEN_<OP> token maps to the same canonical heading class, so a
        // statement-position expected-set yields that phrase 10+ times. Dedup to one entry -
        // the model needs the distinct options, not the alternation count.
        const names = [...new Set(
            types
                .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
                .filter((s): s is string => Boolean(s)),
        )];
        if (names.length === 0) return null;
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} or ${names[1]}`;
        return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
    }

    // {§combined-anchor-line-redirect} The rejected token is a complete bounded
    // scope, so its one canonical correction is known without interpreting intent.
    static #targetedMessage(tok: Token | null): string | null {
        if (tok?.type !== plurnkParser.COMBINED_L_MARKER) return null;
        return COMBINED_ANCHOR_LINE_DIAGNOSTIC;
    }

    // {§bare-target-redirect} A `(` on a BARE heading is the prompt written as a slot; BARE
    // takes none, so the same receipt names the body line.
    static #targetSlotMessage(recognizer: Parser, tok: Token | null): string | null {
        if (tok?.type !== plurnkParser.LPAREN) return null;
        const stream = recognizer.tokenStream;
        for (let i = tok.tokenIndex - 1; i >= 0; i -= 1) {
            const prior = stream.get(i);
            if (prior.line !== tok.line) return null;
            if (prior.type === plurnkParser.OPEN_BARE) {
                const opener = prior.text ?? "## BARE0";
                return `unexpected \`(\` after BARE - BARE takes no \`(path)\`; the prompt is the body: \`${opener}\` then the prompt on the line below`;
            }
        }
        return null;
    }

    // {§send-label} — a label beside a recipient on one SEND heading: the label ends the turn
    // and names no recipient.
    static #labelRecipientMessage(recognizer: Parser, tok: Token | null): string | null {
        if (tok === null || (tok.type !== plurnkParser.SEND_LABEL && tok.type !== plurnkParser.LPAREN)) return null;
        const stream = recognizer.tokenStream;
        let sawLabel = false;
        let sawTarget = false;
        for (let i = tok.tokenIndex - 1; i >= 0; i -= 1) {
            const prior = stream.get(i);
            if (prior.line !== tok.line) return null;
            if (prior.type === plurnkParser.SEND_LABEL) sawLabel = true;
            if (prior.type === plurnkParser.RPAREN) sawTarget = true;
            if (prior.type === plurnkParser.OPEN_SEND) {
                const clash = (tok.type === plurnkParser.SEND_LABEL && sawTarget) || (tok.type === plurnkParser.LPAREN && sawLabel);
                return clash ? "a (NEXT|WAIT|TERM|FAIL) SEND names no recipient; message a recipient with its own SEND first" : null;
            }
        }
        return null;
    }

    // A second `(` on a heading that already closed a `(path)`: the heading has one path slot
    // and a matcher belongs beneath it.
    static #secondPathSlotMessage(recognizer: Parser, tok: Token | null): { message: string; at: Token } | null {
        if (tok?.type !== plurnkParser.LPAREN) return null;
        const stream = recognizer.tokenStream;
        for (let i = tok.tokenIndex - 1; i >= 0; i -= 1) {
            const prior = stream.get(i);
            if (prior.line !== tok.line) return null;
            if (prior.type === plurnkParser.RPAREN) {
                return { at: tok, message: "a heading takes exactly one `(path)` slot; a pattern belongs in the body beneath the heading" };
            }
        }
        return null;
    }

    // {§matcher-prefix-claims} "later statements remain recoverable when their boundaries are
    // trustworthy" - a column-0 heading is that boundary. After a statement-level error, the rest
    // of the broken statement (heading line and body) is discarded and parsing resumes at the next
    // heading, so every later statement - the terminal SEND included - is judged on its own.
    static #HEADING_BOUNDARY: ReadonlySet<number> = new Set([
        plurnkParser.OPEN_PLAN, plurnkParser.OPEN_FIND, plurnkParser.OPEN_READ, plurnkParser.OPEN_EDIT,
        plurnkParser.OPEN_COPY, plurnkParser.OPEN_MOVE,
        plurnkParser.OPEN_SEND, plurnkParser.OPEN_EXEC, plurnkParser.OPEN_BARE, plurnkParser.OPEN_WORK,
        plurnkParser.OPEN_FORK, plurnkParser.OPEN_KILL, plurnkParser.OPEN_LOOK, plurnkParser.OPEN_BUFF,
        plurnkParser.FENCE_CLOSE,
    ]);

    // The entry rules end with EOF; an error raised there means the document expected its end.
    static #ENTRY_RULES: ReadonlySet<string> = new Set(["document", "log", "statementSeq", "clientStatementSeq"]);

    #lastResyncIndex = -1;

    public override recover(recognizer: Parser, _e: RecognitionException): void {
        const stream = recognizer.inputStream;
        let current = recognizer.getCurrentToken();
        // The document expected its end and found more: everything after the terminal SEND is
        // the mid-termination error, reported once. Consume through EOF so the lexer finishes
        // and {§send-mid-reservation} rewrites the diagnostic instead of a false "never closed" tail.
        const rule = recognizer.ruleNames[recognizer.context?.ruleIndex ?? -1] ?? "";
        if (PlurnkErrorStrategy.#ENTRY_RULES.has(rule)) {
            while (current.type !== Token.EOF) { recognizer.consume(); current = recognizer.getCurrentToken(); }
            this.#lastResyncIndex = stream.index;
            return;
        }
        // No progress since the last resync at this position: force one token so the parser
        // cannot loop on a heading it refuses to match.
        if (this.#lastResyncIndex === stream.index && current.type !== Token.EOF) { recognizer.consume(); current = recognizer.getCurrentToken(); }
        while (current.type !== Token.EOF && !PlurnkErrorStrategy.#HEADING_BOUNDARY.has(current.type)) {
            recognizer.consume();
            current = recognizer.getCurrentToken();
        }
        this.#lastResyncIndex = stream.index;
    }

    public override reportError(recognizer: Parser, e: RecognitionException): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);

        const targeted = PlurnkErrorStrategy.#targetedMessage(e.offendingToken);
        if (targeted !== null) {
            recognizer.notifyErrorListeners(targeted, e.offendingToken, e);
            return;
        }
        const destination = PlurnkErrorStrategy.#targetSlotMessage(recognizer, e.offendingToken);
        if (destination !== null) {
            recognizer.notifyErrorListeners(destination, e.offendingToken, e);
            return;
        }
        const labelled = PlurnkErrorStrategy.#labelRecipientMessage(recognizer, e.offendingToken);
        if (labelled !== null) {
            recognizer.notifyErrorListeners(labelled, e.offendingToken, e);
            return;
        }
        const secondSlot = PlurnkErrorStrategy.#secondPathSlotMessage(recognizer, e.offendingToken);
        if (secondSlot !== null) {
            recognizer.notifyErrorListeners(secondSlot.message, secondSlot.at, e);
            return;
        }

        const got = PlurnkErrorStrategy.#describeToken(e.offendingToken);
        const expected = PlurnkErrorStrategy.#describeExpected(e);

        let msg: string;
        if (e instanceof InputMismatchException || e instanceof NoViableAltException) {
            msg = expected ? `unexpected ${got}; expected ${expected}` : `unexpected ${got}`;
        } else {
            msg = `unexpected ${got}`;
        }

        recognizer.notifyErrorListeners(msg, e.offendingToken, e);
    }

    public override reportMissingToken(recognizer: Parser): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);
        const tok = recognizer.getCurrentToken();
        const expectedTokens = this.getExpectedTokens(recognizer);
        const expectedNames = [...new Set(
            expectedTokens
                .toArray()
                .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
                .filter((s): s is string => Boolean(s)),
        )];
        const expected = expectedNames.length > 0
            ? (expectedNames.length === 1 ? expectedNames[0] : expectedNames.join(" or "))
            : "more input";
        const got = PlurnkErrorStrategy.#describeToken(tok);
        const msg = `expected ${expected}; got ${got}`;
        recognizer.notifyErrorListeners(msg, tok, null);
    }

    public override reportUnwantedToken(recognizer: Parser): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);
        const tok = recognizer.getCurrentToken();
        const targeted = PlurnkErrorStrategy.#targetedMessage(tok);
        if (targeted !== null) {
            recognizer.notifyErrorListeners(targeted, tok, null);
            return;
        }
        const destination = PlurnkErrorStrategy.#targetSlotMessage(recognizer, tok);
        if (destination !== null) {
            recognizer.notifyErrorListeners(destination, tok, null);
            return;
        }
        const labelled = PlurnkErrorStrategy.#labelRecipientMessage(recognizer, tok);
        if (labelled !== null) {
            recognizer.notifyErrorListeners(labelled, tok, null);
            return;
        }
        const secondSlot = PlurnkErrorStrategy.#secondPathSlotMessage(recognizer, tok);
        if (secondSlot !== null) {
            recognizer.notifyErrorListeners(secondSlot.message, secondSlot.at, null);
            return;
        }
        const got = PlurnkErrorStrategy.#describeToken(tok);
        const expectedTokens = this.getExpectedTokens(recognizer);
        const expectedNames = [...new Set(
            expectedTokens
                .toArray()
                .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
                .filter((s): s is string => Boolean(s)),
        )];
        const expected = expectedNames.length > 0
            ? (expectedNames.length === 1 ? expectedNames[0] : expectedNames.join(" or "))
            : null;
        const msg = expected
            ? `unexpected ${got}; expected ${expected}`
            : `unexpected ${got}`;
        recognizer.notifyErrorListeners(msg, tok, null);
    }
}
