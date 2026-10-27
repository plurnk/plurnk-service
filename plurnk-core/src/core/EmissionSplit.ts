import { PlurnkParser } from "@plurnk/plurnk-parser";
import { PlurnkParseError, Validator, type Notice, type ParseAttempt, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { BaseHandler, Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { ProviderAttempt, ProviderAttemptFinishReason } from "@plurnk/plurnk-providers";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import FabricatedLog from "./FabricatedLog.ts";
import type { PacketAssistant } from "./StoredPacket.ts";
import { observedSync } from "../observe/spans.ts";

// Internal-only — collected from PlurnkParser output, then translated to
// Notice envelopes are defined by @plurnk/plurnk-contracts.
// before being pushed to the loop's notices buffer.
export type ParseErrorInfo = Pick<PlurnkParseError, "message" | "line" | "column"> & { source: string; recovery?: string; attempt?: ParseAttempt };

// {§fence-pairing}: judges a body in its runtime's declared media type; undefined when none declares one.
export type BodyCheck = (runtime: string, body: string) => boolean;

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
    parseNotices: Notice[];
    emissionValid: boolean;
    emptyTurn: boolean;
    // {§loop-completion}: an incomplete or malformed emission cannot conclude.
    completionAllowed: boolean;
    // {§outside-text}: the text of a turn that fenced no operation, in source order; null when the turn
    // fenced one, since its text then joined the program as NOTEs.
    outside: string | null;
    // {§turn-source-resources}: the admitted content program; null when none was admitted. The emission
    // site renders them against their own source; reasoning operations stay in their own source.
    emissionStatements: readonly PlurnkStatement[] | null;
};

// What the parse of an emission's content yields, before the reasoning operations join it.
type ParsedContent = {
    ops: PlurnkStatement[];
    contentStatementCount: number;
    parseErrors: ParseErrorInfo[];
    parseNotices: Notice[];
    fabrications: ParseErrorInfo[];
    outside: string[];
    hasUnparsedTail: boolean;
    operationOmitted: boolean;
};
type ParsedErrorItem = Extract<ReturnType<typeof PlurnkParser.parse>["items"][number], { kind: "error" }>;

const comparePosition = (
    a: { line: number; column: number },
    b: { line: number; column: number },
): number => a.line - b.line || a.column - b.column;

// {§diagnostic-observation} — what each notice of the model's own output asks of it: MUST where the card says MUST
// or the output was refused, SHOULD where a near-miss was accepted.
export const DIRECTIVE = Object.freeze({
    note: "YOU MUST persist all new facts, ideas, and plans in NOTEs on every turn.",
    emission: "YOU MUST ONLY emit fenced operation batches; with the parameters, pattern, and terse aside on the fenced operation line.",
    advisory: "YOU SHOULD write the canonical form.",
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

    // Split the wire-level ProviderResponse into the two destinations:
    // packet.assistant gets the model's emission (content, ops, reasoning);
    // Turn columns get accepted-call metadata (finishReason, model). Physical
    // request usage and cost have their own cardinal persistence path.
    // {§provider-surface} Text-fragment scraping policy lives
    // here — engine owns the parse and the scraping rule, providers stay
    // grammar-unaware.
    //
    // Test-fixture escape hatch: the Mock provider may pre-supply `ops` on
    // its assistant payload to skip the parse roundtrip. The wire Provider
    // contract has no `ops` field; only Mock exposes one. Real providers
    // always take the parse path because their `assistant.ops` is undefined.
    // {§fence-pairing}: each runtime that declares its body's media type is judged by that media type's
    // handler. The parse is synchronous, so the handler must validate synchronously; one that cannot breaks the
    // declaration's contract and fails here.
    static async bodyChecks(
        workspaceId: number,
        registry: ExecutorRegistry | undefined,
        mimetypes: Mimetypes,
    ): Promise<BodyCheck | undefined> {
        if (registry === undefined) return undefined;
        const declared = registry.availableRuntimes(workspaceId).flatMap((runtime) => {
            const mimetype = registry.entry(runtime, workspaceId)?.invocation.body.mimetype;
            return mimetype === undefined ? [] : [{ runtime, mimetype }];
        });
        if (declared.length === 0) return undefined;
        const handlers = new Map<string, BaseHandler>(await Promise.all(declared.map(async ({ runtime, mimetype }) => {
            const handler = await mimetypes.getHandler(mimetype);
            if (handler === null) throw new Error(`runtime '${runtime}' declares body media type ${mimetype}, which no installed handler reads`);
            return [runtime, handler] as const;
        })));
        return (runtime, body) => {
            const handler = handlers.get(runtime);
            if (handler === undefined) return true;
            let verdict: void | Promise<void>;
            try { verdict = handler.validate(body); } catch { return false; }
            if (verdict instanceof Promise) throw new Error(`the ${runtime} body media type validates asynchronously; a declared body media type must validate synchronously`);
            return true;
        };
    }

    static splitResponse(response: ProviderAttempt, executors: readonly string[] = [], wellFormed?: BodyCheck): SplitProviderResponse {
        const { assistant } = response;
        // A scripted provider's pre-parsed statements, each proven against the statement schema.
        const preParsedOps = "ops" in assistant && Array.isArray(assistant.ops) ? assistant.ops.map((op) => Validator.assertPlurnkStatement(op)) : undefined;
        const { ops, contentStatementCount, parseErrors, parseNotices, fabrications, outside, hasUnparsedTail, operationOmitted } = preParsedOps === undefined
            ? EmissionSplit.#parseContent(assistant.content, executors, wellFormed)
            : {
                ops: [...preParsedOps], contentStatementCount: preParsedOps.length, parseErrors: [], parseNotices: [], fabrications: [],
                outside: [], hasUnparsedTail: false, operationOmitted: false,
            };
        const reasoning = assistant.reasoning ?? null;
        const reasoningOps = reasoning === null ? [] : PlurnkParser.parseReasoningOperations(reasoning, (warning) => {
            parseNotices.push({
                source: "grammar:reasoning",
                kind: "parse_advisory",
                level: "warn",
                directive: DIRECTIVE.advisory,
                message: warning.message,
                parserSource: warning.source,
            });
        });
        const operationCount = contentStatementCount + reasoningOps.length;
        // {§op-shapes}: an admitted reasoning operation is the turn's work, a NOTE as much as a
        // FIND or READ, with or without a content program.
        if (reasoningOps.length > 0) {
            for (let i = parseErrors.length - 1; i >= 0; i--) {
                if (parseErrors[i].message === PlurnkParser.NO_VALID_OPERATION) parseErrors.splice(i, 1);
            }
        }
        parseErrors.unshift(...fabrications.slice(0, 1));
        const emissionStatements = preParsedOps === undefined && contentStatementCount > 0 ? [...ops] : null;
        ops.unshift(...reasoningOps);
        const completionAllowed = !hasUnparsedTail && !operationOmitted && !assistant.nativeToolCalls
            && parseErrors.every((error) => error.message === PlurnkParser.NO_VALID_OPERATION)
            && !["length", "content_filter", "tool_calls"].includes(assistant.finishReason ?? "");
        const emptyTurn = preParsedOps === undefined && operationCount === 0 && !hasUnparsedTail;
        // {§parse-recovery}: outside text is not operational work.
        const emissionValid = fabrications.length === 0 && (preParsedOps !== undefined
            || emptyTurn
            || operationCount > 0);
        const recoverableParseErrors = parseErrors
            .filter((error) => error.message !== PlurnkParser.NO_VALID_OPERATION)
            .toSorted(comparePosition);
        return {
            packetAssistant: { content: assistant.content, ops, reasoning },
            sourceBacked: preParsedOps === undefined,
            callMetadata: { finishReason: assistant.finishReason, model: assistant.model },
            parseErrors,
            recoverableParseErrors: emissionValid ? recoverableParseErrors : [],
            emptyTurn,
            completionAllowed,
            parseNotices,
            emissionValid,
            outside: outside.length === 0 ? null : outside.join("\n\n"),
            emissionStatements,
        };
    }

    // {§outside-text} {§emission-admission} {§parse-recovery} An emission's content parsed into its
    // statements and what sat beside them: outside text as NOTEs or the empty turn's source, a fabricated log
    // heading as the rejection it is, each parse error by its severity, and the lexer's one boundary fact.
    static #parseContent(content: string, executors: readonly string[], wellFormed: BodyCheck | undefined): ParsedContent {
        const ops: PlurnkStatement[] = [];
        const parseErrors: ParseErrorInfo[] = [];
        let contentStatementCount = 0;
        let hasUnparsedTail = false;
        let operationOmitted = false;
        const parseNotices: Notice[] = [];
        const fabrications: ParseErrorInfo[] = [];
        const outside: string[] = [];
        // {§observability-boundary} — the parse is observed without its input;
        // only the resulting statement count is attributable.
        const parsed = observedSync("contracts.parse", {}, (span) => {
            // {§fence-pairing}: explicit invocations parse without registration; available names
            // also admit slotless headings. Dispatch resolves the then-current workspace registry.
            const result = PlurnkParser.parse(content, { executors, ...(wellFormed === undefined ? {} : { wellFormed }) });
            span.setAttribute("statements", result.items.filter((item) => item.kind === "statement").length);
            return result;
        });
        // {§outside-text}: beside a fenced operation, the text between two operations is one NOTE at its
        // position, annotation the model wrote without its fence; a turn that fenced no operation keeps
        // its text as its outside source and stays an empty turn ({§outside-text}). Echoed emission
        // headings are announcements, not annotation, and are dropped ({§emission-admission}).
        const fenced = parsed.items.filter((item) => item.kind === "statement").length;
        let span: { body: string[]; position: PlurnkStatement["position"] } | null = null;
        const flushSpan = (): void => {
            if (span === null) return;
            const body = span.body.join("\n\n");
            if (body.length > 0) {
                if (fenced > 0) {
                    ops.push({ op: "NOTE", aside: null, metadata: null, target: null, lineMarker: null, body, position: span.position });
                    contentStatementCount += 1;
                } else outside.push(body);
            }
            span = null;
        };
        for (const item of parsed.items) {
            if (item.kind !== "text") flushSpan();
            if (item.kind === "statement") {
                ops.push(item.statement);
                contentStatementCount += 1;
            }
            else if (item.kind === "text") {
                // {§emission-admission}: a log-entry heading in outside text rejects the attempt.
                const fabricated = FabricatedLog.find(item.content);
                if (fabricated !== null) {
                    fabrications.push({ message: FabricatedLog.message(fabricated.heading), line: item.position.line + fabricated.line, column: 1, source: "harness" });
                    continue;
                }
                const body = FabricatedLog.stripEchoes(item.content);
                if (body.length === 0) continue;
                span ??= { body: [], position: item.position };
                span.body.push(body);
            }
            else if (item.kind === "error") {
                operationOmitted ||= EmissionSplit.#admitParseError(item, parseErrors, parseNotices);
            }
        }
        flushSpan();
        // {§parse-recovery} — the lexer's one boundary fact: from `unparsedTail.from` on,
        // nothing was read. The statements that closed before it are ordinary facts and run; the
        // loss itself is one more hard diagnostic, a failed row the model sees. An emission that
        // lost its boundary before any statement closed has nothing admissible and is resampled.
        const tail = parsed.unparsedTail;
        if (tail !== undefined) {
            hasUnparsedTail = true;
            parseErrors.push({ message: tail.reason, line: tail.from.line, column: tail.from.column, source: "grammar" });
        }
        return { ops, contentStatementCount, parseErrors, parseNotices, fabrications, outside, hasUnparsedTail, operationOmitted };
    }

    // One parse error by its severity: an advisory is a grammar Notice beside the turn; an error is a diagnostic
    // the model sees, with its recovery and the attempt it came from. Returns whether an operation was omitted.
    static #admitParseError(item: ParsedErrorItem, parseErrors: ParseErrorInfo[], parseNotices: Notice[]): boolean {
        const err = (item as { error?: PlurnkParseError }).error;
        if (err instanceof PlurnkParseError) {
            if (err.severity === "warning") {
                parseNotices.push({
                    source: "grammar",
                    kind: "parse_advisory",
                    level: "warn",
                    directive: DIRECTIVE.advisory,
                    message: err.message,
                    position: {
                        type: "content-offset",
                        line: err.line,
                        column: err.column,
                    },
                    parserSource: err.source,
                });
            } else {
                parseErrors.push({
                    message: err.message, line: err.line, column: err.column, source: err.source,
                    ...(err.recovery === undefined ? {} : { recovery: err.recovery }),
                    ...(item.attempt === undefined ? {} : { attempt: item.attempt }),
                });
            }
        } else {
            const msg = (err as { message?: string } | undefined)?.message ?? "parse error";
            parseErrors.push({ message: msg, line: 0, column: 0, source: "parser" });
        }
        return err instanceof PlurnkParseError && err.operationOmitted;
    }
}
