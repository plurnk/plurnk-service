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

export const COMBINED_ANCHOR_LINE_DIAGNOSTIC =
    "a scope position accepts one line coordinate; use the `@hash` anchor without its displayed line number";

export default class PlurnkErrorStrategy extends DefaultErrorStrategy {
    static #OFFENDING_CHAR_RE = /at: '([^']*)'$/;

    static #LEXER_MODE_CONTEXT: Record<string, string> = {
        DEFAULT_MODE: "before the PLAN heading",
        SLOTS: "in operation heading - expected a space before `[signal]`, `(target)`, or `<scope>`, or a line ending",
        SIGNAL_TAGS: "in tag signal - expected tag, `,`, or `]`",
        SIGNAL_INT: "in signal - expected integer for SEND/KILL, then `]`",
        SIGNAL_IDENT: "in signal - expected executor for EXEC, then `]`",
        TARGET: "in target slot - expected URI characters or `)`",
        BODY: "in body",
    };

    static #SLOT_BY_TOKEN: Record<number, string> = {
        [plurnkParser.OPEN_FIND]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_READ]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_EDIT]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_COPY]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_MOVE]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_OPEN]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_FOLD]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_SEND]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_EXEC]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_BARE]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_WORK]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_FORK]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_KILL]: "H2 operation heading `## OPsuffix`",
        [plurnkParser.OPEN_PLAN]: "PLAN heading `# PLANsuffix`",
        [plurnkParser.OPEN_LOOK]: "H2 client heading `## OPsuffix`",
        [plurnkParser.OPEN_BUFF]: "H2 client heading `## OPsuffix`",
        [plurnkParser.LBRACKET]: "`[` (signal slot opener)",
        [plurnkParser.RBRACKET]: "`]` (signal slot closer)",
        [plurnkParser.LPAREN]: "`(` (target slot opener)",
        [plurnkParser.RPAREN]: "`)` (target slot closer)",
        [plurnkParser.L_MARKER]: "`<L>` line marker",
        [plurnkParser.BODY_OPEN]: "operation-heading line ending",
        [plurnkParser.SECTION_END]: "next same-lane heading",
        [plurnkParser.COMMA]: "`,`",
        [plurnkParser.INT]: "integer (SEND/KILL signal)",
        [plurnkParser.IDENT]: "executor (EXEC signal)",
        [plurnkParser.TAG]: "tag",
        [plurnkParser.TARGET_TEXT]: "target content",
        [plurnkParser.BODY_TEXT]: "body content",
        [plurnkParser.TEXT]: "text before PLAN",
    };

    static translateLexerMessage(lexer: plurnkLexer, originalMsg: string): string {
        const modeName = lexer.modeNames[lexer.mode] ?? "DEFAULT_MODE";
        const context = PlurnkErrorStrategy.#LEXER_MODE_CONTEXT[modeName] ?? "between statements";
        const ch = PlurnkErrorStrategy.#extractOffendingChar(originalMsg);
        // EXEC's identifier cannot start with a digit or `-`, making a leading numeric
        // value an unambiguous misplaced timing scope. {§signal-scope-redirect}
        if (modeName === "SIGNAL_IDENT" && /^'[-\d]'$/.test(ch)) {
            return `unrecognized character ${ch} in signal - timeout/poll ride the \`<scope>\` slot; try \`## EXEC0 <-1,300>\``;
        }
        // Redirect an unambiguous matcher prefix in the slot region into the body. Slash-led
        // regex and XPath are excluded because `/` may instead be a target whose `(...)` wrap
        // was omitted.
        if (modeName === "SLOTS" && /^'[$~@]'$/.test(ch)) {
            return `unrecognized character ${ch} in operation heading - a matcher belongs on the first body line`;
        }
        return `unrecognized character ${ch} ${context}`;
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

    public override reportError(recognizer: Parser, e: RecognitionException): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);

        const targeted = PlurnkErrorStrategy.#targetedMessage(e.offendingToken);
        if (targeted !== null) {
            recognizer.notifyErrorListeners(targeted, e.offendingToken, e);
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
