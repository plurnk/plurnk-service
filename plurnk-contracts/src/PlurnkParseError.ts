export type ErrorSource = "lexer" | "parser" | "visitor";
export type Severity = "error" | "warning";

export default class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;
    readonly severity: Severity;
    // {§parse-recovery}: the working form, for a hard diagnostic; the runtime projects it as the Problem's recovery.
    readonly recovery: string | undefined;
    // {§parse-admission}: severity and loss of an operation are independent facts.
    readonly operationOmitted: boolean;

    constructor(line: number, column: number, source: ErrorSource, message: string, severity: Severity = "error", recovery?: string, operationOmitted = false) {
        super(message);
        this.name = "PlurnkParseError";
        this.line = line;
        this.column = column;
        this.source = source;
        this.severity = severity;
        this.recovery = recovery;
        this.operationOmitted = operationOmitted;
    }

    toJSON(): { line: number; column: number; source: ErrorSource; severity: Severity; message: string; recovery?: string; operationOmitted?: boolean } {
        return {
            line: this.line,
            column: this.column,
            source: this.source,
            severity: this.severity,
            message: this.message,
            ...(this.recovery === undefined ? {} : { recovery: this.recovery }),
            ...(this.operationOmitted ? { operationOmitted: true } : {}),
        };
    }
}
