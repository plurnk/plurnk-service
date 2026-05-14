export type ErrorSource = "lexer" | "parser" | "visitor";

export class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;

    constructor(line: number, column: number, source: ErrorSource, message: string) {
        super(`Plurnk ${source} error at ${line}:${column} — ${message}`);
        this.name = "PlurnkParseError";
        this.line = line;
        this.column = column;
        this.source = source;
    }
}
