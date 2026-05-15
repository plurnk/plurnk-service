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

const LEXER_MODE_CONTEXT: Record<string, string> = {
    DEFAULT_MODE: "between statements",
    OPENED: "in statement header",
    POST_SIGNAL: "in statement header",
    POST_PATH: "in statement header",
    POST_L: "in statement header",
    SIGNAL: "in signal",
    PATH: "in path",
    BODY: "in body",
};

const OFFENDING_CHAR_RE = /at: '([^']*)'$/;

const extractOffendingChar = (msg: string): string => {
    const m = OFFENDING_CHAR_RE.exec(msg);
    if (!m) return "input";
    const text = m[1];
    return text === "" ? "end of input" : `'${text}'`;
};

export const translateLexerMessage = (lexer: plurnkLexer, originalMsg: string): string => {
    const modeName = lexer.modeNames[lexer.mode] ?? "DEFAULT_MODE";
    const context = LEXER_MODE_CONTEXT[modeName] ?? "between statements";
    const ch = extractOffendingChar(originalMsg);
    return `unrecognized character ${ch} ${context}`;
};

const SLOT_BY_TOKEN: Record<number, string> = {
    [plurnkParser.OPEN_FIND]: "open tag",
    [plurnkParser.OPEN_READ]: "open tag",
    [plurnkParser.OPEN_EDIT]: "open tag",
    [plurnkParser.OPEN_COPY]: "open tag",
    [plurnkParser.OPEN_MOVE]: "open tag",
    [plurnkParser.OPEN_SHOW]: "open tag",
    [plurnkParser.OPEN_HIDE]: "open tag",
    [plurnkParser.OPEN_SEND]: "open tag",
    [plurnkParser.OPEN_EXEC]: "open tag",
    [plurnkParser.LBRACKET]: "'['",
    [plurnkParser.RBRACKET]: "']'",
    [plurnkParser.LPAREN]: "'('",
    [plurnkParser.RPAREN]: "')'",
    [plurnkParser.L_MARKER]: "line marker",
    [plurnkParser.COLON]: "':'",
    [plurnkParser.SIGNAL_TEXT]: "signal content",
    [plurnkParser.PATH_TEXT]: "path content",
    [plurnkParser.BODY_TEXT]: "body content",
    [plurnkParser.CLOSE_TAG]: "close tag",
    [plurnkParser.TEXT]: "text between statements",
};

const describeToken = (tok: Token | null): string => {
    if (!tok || tok.type === Token.EOF) return "end of input";
    const slot = SLOT_BY_TOKEN[tok.type];
    if (slot) return slot;
    const text = tok.text ?? "";
    return text.length > 0 ? `'${text}'` : "input";
};

const describeExpected = (
    _parser: Parser,
    e: RecognitionException,
): string | null => {
    const expected = e.getExpectedTokens();
    if (!expected) return null;
    const types: number[] = expected.toArray();
    if (types.length === 0) return null;
    const names = types
        .map((t) => SLOT_BY_TOKEN[t])
        .filter((s): s is string => Boolean(s));
    if (names.length === 0) return null;
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} or ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
};

export class PlurnkErrorStrategy extends DefaultErrorStrategy {
    public override reportError(recognizer: Parser, e: RecognitionException): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);

        const got = describeToken(e.offendingToken);
        const expected = describeExpected(recognizer, e);

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
            .map((t) => SLOT_BY_TOKEN[t])
            .filter((s): s is string => Boolean(s));
        const expected = expectedNames.length > 0
            ? (expectedNames.length === 1 ? expectedNames[0] : expectedNames.join(" or "))
            : "more input";
        const got = describeToken(tok);
        const msg = `expected ${expected}; got ${got}`;
        recognizer.notifyErrorListeners(msg, tok, null);
    }

    public override reportUnwantedToken(recognizer: Parser): void {
        if (this.inErrorRecoveryMode(recognizer)) return;
        this.beginErrorCondition(recognizer);
        const tok = recognizer.getCurrentToken();
        const got = describeToken(tok);
        const expectedTokens = this.getExpectedTokens(recognizer);
        const expectedNames = expectedTokens
            .toArray()
            .map((t) => SLOT_BY_TOKEN[t])
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
