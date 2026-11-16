import { PlurnkParser } from "@plurnk/plurnk-parser";
import { PlurnkParseError, UNKNOWN_POSITION, Validator, isRecord, type ParseAttempt, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ProviderAttempt, ProviderAttemptFinishReason } from "@plurnk/plurnk-providers";
import FabricatedLog from "./FabricatedLog.ts";
import type { PacketAssistant } from "./StoredPacket.ts";
import { observedSync } from "../observe/spans.ts";

// Internal-only — collected from PlurnkParser output, then translated to
// Notice envelopes defined by @plurnk/plurnk-contracts
// before being pushed to the loop's notices buffer.
export type ParseErrorInfo = Pick<PlurnkParseError, "message" | "line" | "column"> & { source: string; recovery?: string; attempt?: ParseAttempt };

// Split-out call-metadata that travels with the parsed packet but lands in
// Turn columns instead of packet.assistant.
type TurnCallMetadata = {
    finishReason: ProviderAttemptFinishReason;
    model: string;
};

export type SplitProviderResponse = {
    packetAssistant: PacketAssistant;
    sourceBacked: boolean;
    callMetadata: TurnCallMetadata;
    parseErrors: ParseErrorInfo[];
    recoverableParseErrors: ParseErrorInfo[];
    emissionValid: boolean;
    emptyTurn: boolean;
    // {§loop-completion}: an incomplete or malformed emission cannot conclude.
    completionAllowed: boolean;
    // {§turn-source-resources}: the admitted content program; null when none was admitted.
    emissionStatements: readonly PlurnkStatement[] | null;
};

type RawWireToolCall = {
    name: string;
    arguments: unknown;
};

type ParsedEmission = {
    ops: PlurnkStatement[];
    parseErrors: ParseErrorInfo[];
    fabrications: ParseErrorInfo[];
    operationOmitted: boolean;
};

const comparePosition = (
    a: { line: number; column: number },
    b: { line: number; column: number },
): number => a.line - b.line || a.column - b.column;

// {§diagnostic-observation} — what each notice of the model's own output asks of it: MUST where the card says MUST
// or the output was refused, SHOULD where a near-miss was accepted.
export const DIRECTIVE = Object.freeze({
    note: "YOU SHOULD take at least one `note` each turn to record your conclusions, findings, and plans.",
    emission: "YOU MUST respond with `mcp` tool calls (`{\"server\":...,\"tool\":...,\"arguments\":{...}}`).",
    output: "YOU SHOULD emit fewer or shorter operations per turn.",
});

export default class EmissionSplit {
    static offsetToLineColumn(content: string, offset: number): { line: number; column: number } {
        const cps = Array.from(content);
        const clamped = Math.max(0, Math.min(offset, cps.length));
        let line = 1;
        let column = 0;
        for (let i = 0; i < clamped; i++) {
            if (cps[i] === "\n") { line++; column = 0; } else { column++; }
        }
        return { line, column };
    }

    static #extractRawToolCalls(assistant: ProviderAttempt["assistant"], assistantRaw: unknown): RawWireToolCall[] {
        if (Array.isArray(assistant.toolCalls) && assistant.toolCalls.length > 0) {
            return assistant.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments }));
        }
        if (isRecord(assistantRaw) && isRecord(assistantRaw.wire) && Array.isArray(assistantRaw.wire.toolCalls)) {
            return assistantRaw.wire.toolCalls.flatMap((call) =>
                isRecord(call) && typeof call.name === "string" && call.name.trim().length > 0
                    ? [{ name: call.name, arguments: call.arguments }]
                    : []);
        }
        return [];
    }

    // Split the wire-level ProviderAttempt into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get accepted-call metadata (finishReason, model).
    //
    // Test-fixture escape hatch: the Mock provider may pre-supply `ops` on
    // its assistant payload to skip lowering. Real providers always take the
    // `mcp` tool-call + assistant-note lowering path.
    static splitResponse(response: ProviderAttempt, executors: readonly string[] = []): SplitProviderResponse {
        const { assistant } = response;
        const rawToolCalls = EmissionSplit.#extractRawToolCalls(assistant, response.assistantRaw);
        const preParsedOps = "ops" in assistant && Array.isArray(assistant.ops)
            ? assistant.ops.map((op) => Validator.assertPlurnkStatement(op))
            : undefined;
        const { ops, parseErrors, fabrications, operationOmitted } = preParsedOps === undefined
            ? EmissionSplit.#lowerEmission(assistant.content, rawToolCalls, executors)
            : { ops: [...preParsedOps], parseErrors: [], fabrications: [], operationOmitted: false };
        const reasoning = assistant.reasoning ?? null;
        const operationCount = ops.length;
        parseErrors.unshift(...fabrications.slice(0, 1));
        const emissionStatements = preParsedOps === undefined && operationCount > 0 ? [...ops] : null;
        const unparsedToolCalls = (assistant.finishReason === "tool_calls" || rawToolCalls.length > 0) && operationCount === 0;
        const completionAllowed = !operationOmitted && !unparsedToolCalls
            && parseErrors.every((error) => error.message === PlurnkParser.NO_VALID_EXPRESSION)
            && !["length", "content_filter"].includes(assistant.finishReason ?? "");
        const recoverableParseErrors = parseErrors
            .filter((error) => error.message !== PlurnkParser.NO_VALID_EXPRESSION)
            .toSorted(comparePosition);
        if (unparsedToolCalls && parseErrors.length === 0) {
            parseErrors.push({ message: PlurnkParser.NO_VALID_EXPRESSION, line: 1, column: 0, source: "parser" });
        }
        const emptyTurn = preParsedOps === undefined && operationCount === 0 && !unparsedToolCalls && fabrications.length === 0;
        const emissionValid = fabrications.length === 0 && (preParsedOps !== undefined
            || emptyTurn
            || operationCount > 0);
        const effectiveContent = preParsedOps !== undefined
            ? assistant.content
            : ops.length > 0
                ? PlurnkParser.stringify(ops)
                : assistant.content.trim().length > 0
                    ? assistant.content
                    : rawToolCalls.length > 0
                        ? JSON.stringify(rawToolCalls)
                        : assistant.content;
        return {
            packetAssistant: { content: effectiveContent, ops, reasoning },
            sourceBacked: preParsedOps === undefined,
            callMetadata: { finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
            recoverableParseErrors: emissionValid ? recoverableParseErrors : [],
            emptyTurn,
            completionAllowed,
            emissionValid,
            emissionStatements,
        };
    }

    // {§outside-text} {§emission-admission} {§parse-recovery} Lower non-empty assistant prose into a
    // leading `plurnk.note` (unless it fabricates a log heading) and lower each wire `mcp` tool call
    // into its `PlurnkStatement`.
    static #lowerEmission(content: string, rawToolCalls: readonly RawWireToolCall[], executors: readonly string[]): ParsedEmission {
        const ops: PlurnkStatement[] = [];
        const parseErrors: ParseErrorInfo[] = [];
        const fabrications: ParseErrorInfo[] = [];
        let operationOmitted = false;

        if (content.trim().length > 0) {
            const fabricated = FabricatedLog.find(content);
            if (fabricated !== null) {
                fabrications.push({
                    message: FabricatedLog.message(fabricated.heading),
                    line: 1 + fabricated.line,
                    column: 1,
                    source: "harness",
                });
            } else {
                const body = FabricatedLog.stripEchoes(content);
                if (body.length > 0) {
                    ops.push({
                        op: "note",
                        aside: null,
                        target: null,
                        lineMarker: null,
                        body,
                        position: UNKNOWN_POSITION,
                    });
                }
            }
        }

        // {§observability-boundary} — lowering is observed without its input;
        // only the resulting statement count is attributable.
        observedSync("contracts.parse", {}, (span) => {
            for (const [index, call] of rawToolCalls.entries()) {
                const position = { line: index + 1, column: 0 };
                const lowered = PlurnkParser.lowerMcpCall(
                    { name: call.name, arguments: call.arguments },
                    { executors, position },
                );
                for (const item of lowered.items) {
                    if (item.kind === "statement") {
                        ops.push(item.statement);
                    } else if (item.kind === "error") {
                        operationOmitted ||= EmissionSplit.#admitParseError(item, parseErrors, position);
                    }
                }
            }
            span.setAttribute("statements", ops.length);
        });

        return { ops, parseErrors, fabrications, operationOmitted };
    }

    static #admitParseError(
        item: { error: PlurnkParseError; attempt?: ParseAttempt },
        parseErrors: ParseErrorInfo[],
        fallbackPosition = UNKNOWN_POSITION,
    ): boolean {
        const err = item.error;
        if (err instanceof PlurnkParseError) {
            if (err.severity !== "warning") {
                const line = err.line > 0 ? err.line : fallbackPosition.line;
                const column = err.line > 0 ? err.column : fallbackPosition.column;
                parseErrors.push({
                    message: err.message,
                    line,
                    column,
                    source: err.source,
                    ...(err.recovery === undefined ? {} : { recovery: err.recovery }),
                    ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
                });
            }
            return err.operationOmitted;
        }
        const msg = (err as { message?: string } | undefined)?.message ?? "parse error";
        parseErrors.push({ message: msg, line: fallbackPosition.line, column: fallbackPosition.column, source: "parser" });
        return false;
    }
}
