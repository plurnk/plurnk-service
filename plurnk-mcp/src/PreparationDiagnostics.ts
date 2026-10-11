import { StringDecoder } from "node:string_decoder";

export interface PreparationDiagnostic {
    readonly diagnostic?: string;
    readonly stderr?: string;
}

// {§mcp-preparation-diagnostics} One bounded observation of the public transport.
export default class PreparationDiagnostics {
    readonly #limit: number;
    readonly #values: readonly string[];
    readonly #overlap: number;
    readonly #decoder = new StringDecoder("utf8");
    #tail = "";
    #truncated = false;

    constructor(values: readonly string[], limit: number) {
        this.#limit = limit;
        this.#values = [...new Set(values.filter((value) => value.length > 0))];
        this.#overlap = this.#values.reduce((longest, value) => Math.max(longest, value.length), 0);
    }

    write(chunk: Buffer): void {
        if (this.#limit === 0) return;
        const text = this.#tail + this.#decoder.write(chunk);
        this.#truncated ||= text.length > this.#limit + this.#overlap;
        this.#tail = text.slice(-(this.#limit + this.#overlap));
    }

    #redact(text: string, hiddenPrefix = 0): string {
        // Overlapping values must be masked together; replacing one first must
        // not expose the remainder of another value that overlaps it.
        const spans = this.#values.flatMap((value) => {
            const matches: Array<{ start: number; end: number }> = [];
            for (let start = text.indexOf(value); start !== -1; start = text.indexOf(value, start + 1)) {
                matches.push({ start, end: start + value.length });
            }
            return matches;
        });
        // A retained tail can start inside a value. Its overlap is observation
        // context, never display text, even if later redaction shortens the tail.
        if (hiddenPrefix > 0) spans.push({ start: 0, end: hiddenPrefix });
        spans.sort((a, b) => a.start - b.start || b.end - a.end);
        let result = "";
        let end = 0;
        for (const span of spans) {
            if (span.end <= end) continue;
            if (span.start >= end) result += `${text.slice(end, span.start)}__redacted__`;
            end = span.end;
        }
        return result + text.slice(end);
    }

    describe(cause: unknown): PreparationDiagnostic {
        if (this.#limit === 0) return {};
        const seen = new Set<unknown>();
        const messages = new Set<string>();
        const visit = (error: unknown): void => {
            if (!(error instanceof Error) || seen.has(error)) return;
            seen.add(error);
            if (error instanceof AggregateError) for (const inner of error.errors) visit(inner);
            visit(error.cause);
            messages.add(error.message);
        };
        visit(cause);
        const text = [...messages].join("; ").slice(0, this.#limit + this.#overlap);
        const diagnostic = this.#redact(text).slice(0, this.#limit).trim();
        const stderr = this.#redact(this.#tail, this.#truncated ? this.#overlap : 0).slice(-this.#limit).trim();
        return { ...(diagnostic === "" ? {} : { diagnostic }), ...(stderr === "" ? {} : { stderr }) };
    }
}
