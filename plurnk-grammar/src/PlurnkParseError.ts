import type { TelemetryEvent } from "./types.generated.ts";

export type ErrorSource = "lexer" | "parser" | "visitor";
export type Severity = "error" | "warning";

export default class PlurnkParseError extends Error {
    readonly line: number;
    readonly column: number;
    readonly source: ErrorSource;
    readonly severity: Severity;

    constructor(line: number, column: number, source: ErrorSource, message: string, severity: Severity = "error") {
        super(`Plurnk ${source} ${severity} at line ${line}:${column} - ${message}`);
        this.name = "PlurnkParseError";
        this.line = line;
        this.column = column;
        this.source = source;
        this.severity = severity;
    }

    toJSON(): { line: number; column: number; source: ErrorSource; severity: Severity; message: string } {
        return {
            line: this.line,
            column: this.column,
            source: this.source,
            severity: this.severity,
            message: this.message,
        };
    }

    toTelemetryEvent(): TelemetryEvent {
        return {
            source: "grammar",
            kind: `parse_error:${this.source}`,
            level: this.severity === "warning" ? "warn" : "error",
            message: this.message,
            position: {
                type: "content-offset",
                line: this.line,
                column: this.column,
            },
        };
    }
}
