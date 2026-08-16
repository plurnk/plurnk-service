/**
 * Independent conformance parser for Core-owned {§jsonplurnk}. Keeping this in
 * test support prevents the renderer and its corpus checker from sharing an
 * implementation without making the checker a package API.
 */
export default class Jsonplurnk {
    static #OPENER = /"body":"\n/g;
    static #COORDINATE = /^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/;

    static strip(block: string): string {
        const opener = Jsonplurnk.#OPENER;
        opener.lastIndex = 0;
        let out = "";
        let cursor = 0;
        let m: RegExpExecArray | null;
        while ((m = opener.exec(block)) !== null) {
            const contentStart = m.index + m[0].length;
            const closeStart = Jsonplurnk.#findClose(block, contentStart);
            out += block.slice(cursor, m.index) + '"body":' + JSON.stringify(block.slice(contentStart, closeStart));
            cursor = closeStart + 1;
            opener.lastIndex = cursor;
        }
        return out + block.slice(cursor);
    }

    static parse(block: string): unknown {
        return JSON.parse(Jsonplurnk.strip(block));
    }

    static #findClose(block: string, from: number): number {
        let at = from;
        let coordinateLines = 0;
        while (at < block.length) {
            if (block[at] === '"' && (block[at + 1] === "}" || block[at + 1] === ",")) {
                if (coordinateLines === 0) {
                    throw new Error("jsonplurnk: raw multiline body must contain a coordinate line");
                }
                return at;
            }
            const newline = block.indexOf("\n", at);
            const end = newline === -1 ? block.length : newline;
            const line = block.slice(at, end).replace(/\r$/, "");
            if (!Jsonplurnk.#COORDINATE.test(line)) {
                throw new Error("jsonplurnk: body line is missing its coordinate prefix");
            }
            coordinateLines++;
            if (newline === -1) break;
            at = newline + 1;
        }
        throw new Error("jsonplurnk: unterminated raw multiline body");
    }
}
