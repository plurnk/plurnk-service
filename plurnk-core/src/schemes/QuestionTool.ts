import { BaseExecutor, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeDecl } from "@plurnk/plurnk-execs";
import type { SchemeFlagAffinity } from "@plurnk/plurnk-schemes";
import { Validator } from "@plurnk/plurnk-contracts";

// {§question-tool} — the native request-user-input runtime. The model asks the
// human through one registered EXEC tool, wired directly against the standard
// client-interaction lifecycle (no loopback MCP, no proposal masquerade). The
// body is the MCP2 2026-07-28 form-elicitation shape verbatim —
// `{ message, requestedSchema }` — and the result is the standard
// `ElicitResult` (`{ action: "accept" | "cancel", content? }`), so nothing
// bespoke crosses the wire. Effect `read`: the tool observes the human's
// answer and never mutates the host, so it is never proposal-gated.

const QUESTION_BODY_EXAMPLE = `{"message": "Which branch should I target?", "requestedSchema": {"type": "object", "properties": {"branch": {"type": "string", "enum": ["main", "feat/x"]}}, "required": ["branch"]}}`;

export const questionRuntimeDecl: RuntimeDecl = {
    name: "question",
    glyph: "❓",
    summary: "Ask the user to answer a question.",
    invocation: {
        body: { role: "MCP2 form-elicitation object", required: true },
        example: { body: QUESTION_BODY_EXAMPLE },
    },
    details: `## Inputs

| Field | Contract |
| --- | --- |
| \`message\` | The question shown to the user (non-empty string). |
| \`requestedSchema\` | JSON Schema object the user's answer must satisfy; \`enum\`/enumNames/oneOf/array/boolean/string/number forms supported. |

The tool pauses its loop until the user answers. The result is \`{ "action": "accept", "content": <answer> }\` or \`{ "action": "cancel" }\`.`,
};

export default class QuestionTool extends BaseExecutor {
    // {§manifest-flag-affinity} — asking the human IS interaction: a
    // noInteraction loop gates this runtime at dispatch with the taught 403.
    override get flags(): SchemeFlagAffinity {
        return { requiresInteraction: true };
    }

    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    override effect(_target: string | null): Effect {
        return "read";
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "in-process" };
    }

    override async run({ body, signal, write, setState, interact }: ExecArgs): Promise<ExecResult> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(body);
        } catch {
            setState("results", "errored");
            return Results.failure(
                "executor:question",
                "invalid-body",
                400,
                "The question body is not valid JSON.",
                {},
                { recovery: "Use the MCP2 form-elicitation shape: { message, requestedSchema }.", retryable: false },
            );
        }
        const r = parsed as { message?: unknown; requestedSchema?: unknown } | null;
        if (r === null || typeof r !== "object"
            || typeof r.message !== "string" || r.message.length === 0
            || typeof r.requestedSchema !== "object" || r.requestedSchema === null) {
            setState("results", "errored");
            return Results.failure(
                "executor:question",
                "invalid-body",
                400,
                "The question body must carry a non-empty message and a requestedSchema object.",
                {},
                { recovery: "Use the MCP2 form-elicitation shape: { message, requestedSchema }.", retryable: false },
            );
        }
        signal.throwIfAborted();
        // The contracts-owned wire is the exact shape MCP2 MRTR elicitation
        // already produces; the executor owns only the mapping from the body.
        const request = Validator.assertClientInteractionRequest({
            toolName: "question",
            arguments: { message: r.message, requestedSchema: r.requestedSchema },
            message: r.message,
            responseSchema: r.requestedSchema as Record<string, unknown>,
        });
        const resolution = await interact(request);
        // The resolution payload IS the standard ElicitResult — return it
        // verbatim when well-formed; otherwise wrap it as the accepted content.
        const payload = resolution.status === "resolved" ? resolution.payload : undefined;
        const result = payload !== null && typeof payload === "object"
            && ((payload as { action?: unknown }).action === "accept"
                || (payload as { action?: unknown }).action === "decline"
                || (payload as { action?: unknown }).action === "cancel")
            ? payload as { action: "accept" | "decline" | "cancel"; content?: unknown }
            : resolution.status === "cancelled"
                ? { action: "cancel" as const }
                : { action: "accept" as const, content: payload ?? {} };
        write("results", `${JSON.stringify(result, null, 2)}\n`, "application/json");
        setState("results", "closed");
        return { status: 200, attrs: { action: result.action } };
    }
}
