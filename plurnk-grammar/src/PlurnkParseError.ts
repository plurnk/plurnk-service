import type { TelemetryEvent } from "./types.generated.ts";

export type ErrorSource = "lexer" | "parser" | "visitor";

export default class PlurnkParseError extends Error {
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

    toJSON(): { line: number; column: number; source: ErrorSource; message: string } {
        return {
            line: this.line,
            column: this.column,
            source: this.source,
            message: this.message,
        };
    }

    toTelemetryEvent(): TelemetryEvent {
        return {
            source: "grammar",
            kind: `parse_error:${this.source}`,
            message: this.message,
            position: {
                type: "content-offset",
                line: this.line,
                column: this.column,
            },
        };
    }
}
