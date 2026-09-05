export type ErrorSource = "lexer" | "parser" | "visitor";
export type Severity = "error" | "warning";

export default class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;
    readonly severity: Severity;
    readonly code?: "missing-terminal-send" | "invalid-turn-structure";

    constructor(line: number, column: number, source: ErrorSource, message: string, severity: Severity = "error", code?: PlurnkParseError["code"]) {
        super(message);
        this.name = "PlurnkParseError";
        this.line = line;
        this.column = column;
        this.source = source;
        this.severity = severity;
        this.code = code;
    }

    toJSON(): { line: number; column: number; source: ErrorSource; severity: Severity; message: string; code?: PlurnkParseError["code"] } {
        return {
            line: this.line,
            column: this.column,
            source: this.source,
            severity: this.severity,
            message: this.message,
            ...(this.code === undefined ? {} : { code: this.code }),
        };
    }
}
