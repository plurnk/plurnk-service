/**
 * jsonplurnk: the Log section's clean-markdown form (grammar#437). A JSON array of entry
 * objects with exactly ONE deviation from valid JSON - each `body` value, when present, is a
 * raw HEREDOC (`<<:::TAG … :::TAG`, TAG = the entry's target/log URI) rendered verbatim rather
 * than JSON-escaped, so the model reads it as natural text instead of an escaped blob.
 *
 * `strip` reverses that one deviation (heredoc body -> escaped JSON string) so the whole block
 * parses as ordinary JSON; everything else is already valid JSON and passes through untouched.
 * The TAG echo on the opener names its own closing delimiter, so a body can hold anything but a
 * column-0 line that exactly matches `:::<that TAG>`.
 *
 * Core renders jsonplurnk; grammar owns this strip-parser and the magnum-opus assertion (every
 * outbound Log strips to valid JSON under the one carve-out).
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

    // strip, then parse. The magnum-opus assertion reduces to: this does not throw on a valid Log.
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
