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

export default class PlurnkErrorStrategy extends DefaultErrorStrategy {
    static #OFFENDING_CHAR_RE = /at: '([^']*)'$/;

    static #LEXER_MODE_CONTEXT: Record<string, string> = {
        DEFAULT_MODE: "between statements",
        SLOTS: "in slot region — expected `[signal]`, `(target)`, `<L>`, or `:body:` (any order)",
        SIGNAL_TAGS: "in tag signal — expected tag, `,`, or `]`",
        SIGNAL_INT: "in signal — expected integer for SEND, then `]`",
        SIGNAL_IDENT: "in signal — expected executor for EXEC, then `]`",
        TARGET: "in target slot — expected URI characters or `)`",
        BODY: "in body",
    };

    static #SLOT_BY_TOKEN: Record<number, string> = {
        [plurnkParser.OPEN_FIND]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_READ]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_EDIT]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_COPY]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_MOVE]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_OPEN]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_FOLD]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_SEND]: "open tag `<<OPsuffix`",
        [plurnkParser.OPEN_EXEC]: "open tag `<<OPsuffix`",
        [plurnkParser.LBRACKET]: "`[` (signal slot opener)",
        [plurnkParser.RBRACKET]: "`]` (signal slot closer)",
        [plurnkParser.LPAREN]: "`(` (target slot opener)",
        [plurnkParser.RPAREN]: "`)` (target slot closer)",
        [plurnkParser.L_MARKER]: "`<L>` line marker",
        [plurnkParser.COLON]: "`:` (body fence)",
        [plurnkParser.COMMA]: "`,`",
        [plurnkParser.INT]: "integer (SEND signal)",
        [plurnkParser.IDENT]: "executor (EXEC signal)",
        [plurnkParser.TAG]: "tag",
        [plurnkParser.TARGET_TEXT]: "target content",
        [plurnkParser.BODY_TEXT]: "body content",
        [plurnkParser.CLOSE_TAG]: "close tag `:OPsuffix`",
        [plurnkParser.TEXT]: "text between statements",
    };

    static translateLexerMessage(lexer: plurnkLexer, originalMsg: string): string {
        const modeName = lexer.modeNames[lexer.mode] ?? "DEFAULT_MODE";
        const context = PlurnkErrorStrategy.#LEXER_MODE_CONTEXT[modeName] ?? "between statements";
        const ch = PlurnkErrorStrategy.#extractOffendingChar(originalMsg);
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
        const names = types
            .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
            .filter((s): s is string => Boolean(s));
        if (names.length === 0) return null;
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} or ${names[1]}`;
        return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
    }

    public override reportError(recognizer: Parser, e: RecognitionException): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);

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
        const expectedNames = expectedTokens
            .toArray()
            .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
            .filter((s): s is string => Boolean(s));
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
        const got = PlurnkErrorStrategy.#describeToken(tok);
        const expectedTokens = this.getExpectedTokens(recognizer);
        const expectedNames = expectedTokens
            .toArray()
            .map((t) => PlurnkErrorStrategy.#SLOT_BY_TOKEN[t])
            .filter((s): s is string => Boolean(s));
        const expected = expectedNames.length > 0
            ? (expectedNames.length === 1 ? expectedNames[0] : expectedNames.join(" or "))
            : null;
        const msg = expected
            ? `unexpected ${got}; expected ${expected}`
            : `unexpected ${got}`;
        recognizer.notifyErrorListeners(msg, tok, null);
    }
}
