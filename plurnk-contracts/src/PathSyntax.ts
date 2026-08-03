// A depth-zero `)` closes a model-language target slot. Parentheses within an
// address therefore use the contract's narrow `%28`/`%29` spelling. This is
// intentionally not general percent decoding: every other escape and literal
// percent sign belongs to the addressed path. {§path-parentheses}
export default class PathSyntax {
    static encodeParens(value: string): string {
        return value.replace(/\(/g, "%28").replace(/\)/g, "%29");
    }

    static decodeParens(value: string): string {
        return value.replace(/%28/gi, "(").replace(/%29/gi, ")");
    }
}
