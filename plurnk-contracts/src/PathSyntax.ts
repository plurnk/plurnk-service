// Target-slot quoting and pathname-parenthesis aliasing are distinct layers.
// Neither is general URI encoding or decoding. {§path-parentheses}
export default class PathSyntax {
    // {§path-glob} The index is shared with consumers that use
    // the literal prefix only as a candidate-set optimization.
    static globMagicIndex(value: string): number {
        for (let index = 0; index < value.length; index += 1) {
            const character = value[index];
            // An escape changes glob interpretation even when no later magic
            // appears, so it cannot be admitted as an exact path byte here.
            if (character === "\\") return index;
            if (character === "*" || character === "?" || character === "[" || character === "{") return index;
            if ((character === "!" || character === "+" || character === "@") && value[index + 1] === "(") return index;
        }
        return -1;
    }

    static hasGlob(value: string): boolean {
        return PathSyntax.globMagicIndex(value) >= 0;
    }

    static escapeTarget(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/[()]/g, "\\$&");
    }

    static unescapeTarget(value: string): string {
        return value.replace(/\\([\\()])/g, "$1");
    }

    static encodeParens(value: string): string {
        return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
    }

    static decodeParens(value: string): string {
        return value.replace(/%28/gi, "(").replace(/%29/gi, ")");
    }
}
