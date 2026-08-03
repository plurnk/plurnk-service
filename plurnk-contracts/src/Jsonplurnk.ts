/**
 * Reverses jsonplurnk's single deviation from JSON: raw HEREDOC body values
 * become escaped JSON strings. Core owns rendering; contracts owns stripping.
 * {§jsonplurnk}
 */
export default class Jsonplurnk {
    // `"body":`, then any whitespace/newlines, then the heredoc opener `<<:::`.
    static #OPENER = /"body":\s*<<:::/g;

    // Reverse the one deviation: rewrite every heredoc `body` value as a JSON-escaped string.
    // Throws on an opener its `:::TAG` never closes - a renderer contract violation, surfaced.
    static strip(block: string): string {
        const opener = Jsonplurnk.#OPENER;
        opener.lastIndex = 0;
        let out = "";
        let cursor = 0;
        let m: RegExpExecArray | null;
        while ((m = opener.exec(block)) !== null) {
            const tagStart = m.index + m[0].length;
            const eol = block.indexOf("\n", tagStart);
            if (eol === -1) throw new Error("jsonplurnk: body opener <<:::… has no newline");
            const tag = block.slice(tagStart, eol);
            const close = `:::${tag}`;
            const contentStart = eol + 1;
            const closeStart = Jsonplurnk.#findClose(block, contentStart, close);
            if (closeStart === -1) throw new Error(`jsonplurnk: unterminated body <<:::${tag}`);
            out += block.slice(cursor, m.index) + '"body":' + JSON.stringify(block.slice(contentStart, closeStart));
            cursor = closeStart + close.length;
            opener.lastIndex = cursor;
        }
        return out + block.slice(cursor);
    }

    // Strip, then parse as ordinary JSON.
    static parse(block: string): unknown {
        return JSON.parse(Jsonplurnk.strip(block));
    }

    // Index where the closing `:::TAG` line begins - it must occupy a whole line at column 0,
    // either right at `from` (an empty body) or immediately after a newline. A `:::TAG` with
    // trailing characters on its line does not close; keep scanning.
    static #findClose(block: string, from: number, close: string): number {
        if (block.startsWith(close, from) && Jsonplurnk.#endsLine(block, from + close.length)) return from;
        let at = from;
        for (;;) {
            const nl = block.indexOf(`\n${close}`, at);
            if (nl === -1) return -1;
            const start = nl + 1;
            if (Jsonplurnk.#endsLine(block, start + close.length)) return start;
            at = start;
        }
    }

    static #endsLine(block: string, pos: number): boolean {
        return pos === block.length || block[pos] === "\n";
    }
}
