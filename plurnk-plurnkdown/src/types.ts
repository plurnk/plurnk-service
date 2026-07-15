export type Severity = "error" | "warning";

export interface Diagnostic {
    rule: string;
    severity: Severity;
    message: string;
    line: number;
    column: number;
}
