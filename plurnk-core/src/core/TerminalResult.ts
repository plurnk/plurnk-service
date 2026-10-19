import Results, { type SchemeResult } from "./results.ts";
import type { StoredEntryData } from "@plurnk/plurnk-schemes";

export interface TerminalPresentation {
    readonly content: string;
    readonly mimetype: string;
}

export default class TerminalResult {
    static representation(result: SchemeResult, resource: string, terminatedBy: string | null): StoredEntryData {
        const presentation = TerminalResult.present(result, { terminatedBy });
        const projected = new Set(["content", "mimetype", "channel", "startLine", "region", "matches", "range"]);
        const producerResult = Results.assertChannelProducerResult({
            ...Object.fromEntries(Object.entries(result).filter(([field]) => !projected.has(field))),
            status: result.status,
            resource,
        });
        return { channels: { body: {
            content: presentation?.content ?? "", mimetype: presentation?.mimetype ?? "text/markdown",
            state: "static", producerResult,
        } } };
    }

    static success(content: string | null, mimetype = "text/markdown"): SchemeResult {
        return Results.assert(content === null || content.length === 0
            ? { status: 200 }
            : { status: 200, content, mimetype });
    }

    static present(
        result: SchemeResult,
        options: {
            terminatedBy?: string | null;
        } = {},
    ): TerminalPresentation | null {
        const exact = Results.assert(result);
        const resultContent = typeof exact.content === "string" && exact.content.length > 0
            ? exact.content
            : null;
        const problemContent = exact.problem?.detail ?? null;
        let content = resultContent ?? problemContent ?? "";
        if (options.terminatedBy === "cancel") {
            content = `[ worker cancelled ]${content.length === 0 ? "" : ` ${content}`}`;
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
