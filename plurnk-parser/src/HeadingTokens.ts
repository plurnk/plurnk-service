import type { Token } from "antlr4ng";
import { plurnkParser } from "./generated/plurnkParser.ts";

// {§heading-slot-order} — a heading near-miss with exactly one reading is read, never refused and
// never taught (#758). Tokens keep their source positions; only their order in the stream changes.
// An aside written before the heading's remaining scope or JSON option block
// (`READ (a.md) <!-- why --> <1,-1>`) is moved after them, where the grammar reads it. An aside
// followed by a target, or by an option block that is not JSON objects, keeps its place.
export default class HeadingTokens {
    static readonly #OPENERS: ReadonlySet<number> = new Set([
        plurnkParser.OPEN_FIND, plurnkParser.OPEN_READ, plurnkParser.OPEN_EDIT, plurnkParser.OPEN_COPY,
        plurnkParser.OPEN_MOVE, plurnkParser.OPEN_SEND, plurnkParser.OPEN_NOTE, plurnkParser.OPEN_WAIT,
        plurnkParser.OPEN_EXEC, plurnkParser.OPEN_BARE, plurnkParser.OPEN_WORK, plurnkParser.OPEN_FORK,
        plurnkParser.OPEN_KILL, plurnkParser.OPEN_LOOK,
    ]);
    static readonly #SLOTS: ReadonlySet<number> = new Set([
        plurnkParser.LPAREN, plurnkParser.TARGET_TEXT, plurnkParser.RPAREN, plurnkParser.L_MARKER,
        plurnkParser.LBRACKET, plurnkParser.METADATA_TEXT, plurnkParser.RBRACKET,
    ]);

    static normalize(tokens: readonly Token[]): Token[] {
        const out: Token[] = [];
        for (let i = 0; i < tokens.length; i++) {
            if (!HeadingTokens.#OPENERS.has(tokens[i].type)) { out.push(tokens[i]); continue; }
            let end = i + 1;
            while (end < tokens.length && (HeadingTokens.#SLOTS.has(tokens[end].type) || tokens[end].type === plurnkParser.ASIDE)) end++;
            out.push(tokens[i]!, ...HeadingTokens.#heading(tokens.slice(i + 1, end)));
            i = end - 1;
        }
        return out;
    }

    static #heading(slots: Token[]): Token[] {
        const at = slots.findIndex((token) => token.type === plurnkParser.ASIDE);
        if (at === -1 || slots.filter((token) => token.type === plurnkParser.ASIDE).length !== 1) return slots;
        const after = slots.slice(at + 1);
        if (after.length === 0 || !HeadingTokens.#scopeOrOptions(after)) return slots;
        return [...slots.slice(0, at), ...after, slots[at]!];
    }

    // Only line markers and `[{…}]` option blocks may follow the aside for it to move.
    static #scopeOrOptions(tokens: Token[]): boolean {
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token.type === plurnkParser.L_MARKER) continue;
            if (token.type !== plurnkParser.LBRACKET) return false;
            if (tokens[i + 1]?.type !== plurnkParser.METADATA_TEXT || !tokens[i + 1]!.text?.trimStart().startsWith("{")) return false;
            while (i < tokens.length && tokens[i]!.type !== plurnkParser.RBRACKET) i++;
            if (i === tokens.length) return false;
        }
        return true;
    }
}
