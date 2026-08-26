import Results, { type SchemeResult } from "./results.ts";

export interface TerminalPresentation {
    readonly content: string;
    readonly mimetype: string;
}

export default class TerminalResult {
    static success(content: string | null): SchemeResult {
        return Results.assert(content === null || content.length === 0
            ? { status: 200 }
            : { status: 200, content, mimetype: "text/markdown" });
    }

    static assert(value: unknown, subject: string): SchemeResult {
        try {
            return Results.assert(value as SchemeResult);
        } catch (cause) {
            throw new Error(`${subject} does not contain a valid terminal result`, { cause });
        }
    }

    static parse(serialized: string, subject: string): SchemeResult {
        let parsed: unknown;
        try {
            parsed = JSON.parse(serialized) as unknown;
        } catch (cause) {
            throw new Error(`${subject} does not contain a valid terminal result`, { cause });
        }
        return TerminalResult.assert(parsed, subject);
    }

    static present(
        result: SchemeResult,
        options: {
            terminatedBy?: string | null;
            receipt?: string | null;
            fallback?: string | null;
        } = {},
    ): TerminalPresentation | null {
        const exact = Results.assert(result);
        const resultContent = typeof exact.content === "string" && exact.content.length > 0
            ? exact.content
            : null;
        const problemContent = exact.problem?.detail ?? null;
        // A branch receipt is a deliverable in itself: the branch now exists. The
        // "no deliverable" fallback only stands when nothing was returned at all.
        const hasReceipt = options.receipt !== undefined && options.receipt !== null;
        let content = resultContent ?? problemContent ?? (hasReceipt ? "" : options.fallback ?? "");
        if (options.terminatedBy === "cancel") {
            content = `[ cancelled from outside the worker ]${content.length === 0 ? "" : ` ${content}`}`;
        }
        if (options.receipt !== undefined && options.receipt !== null) {
            content = content.length === 0 ? options.receipt : `${content}\n\n${options.receipt}`;
        }
        if (content.length === 0) return null;
        return {
            content,
            mimetype: resultContent !== null && typeof exact.mimetype === "string"
                ? exact.mimetype
                : "text/markdown",
        };
    }
}
