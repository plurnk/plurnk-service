import { BaseExecutor, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability, RuntimeRegisteredTool } from "@plurnk/plurnk-execs";
import { Validator, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../core/results.ts";

// {§question-tool} — the native request-user-input tool on the `plurnk` runtime.
// The model asks the human through `plurnk (question)`, wired directly against the
// standard client-interaction lifecycle (no loopback MCP, no proposal masquerade).
// The body is the MCP2 2026-07-28 form-elicitation shape verbatim —
// `{ message, requestedSchema }` — and the result is the standard
// `ElicitResult` (`{ action: "accept" | "cancel", content? }`), so nothing
// bespoke crosses the wire. Effect `read`: the tool observes the human's
// answer and never mutates the host, so it is never proposal-gated.

export const QUESTION_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["message", "requestedSchema"],
    properties: {
        message: {
            type: "string",
            minLength: 1,
            description: "The question shown to the user (non-empty string).",
        },
        requestedSchema: {
            type: "object",
            description: "JSON Schema object the user's answer must satisfy; enum/enumNames/oneOf/array/boolean/string/number forms supported.",
        },
    },
} as const satisfies JsonSchema;

const QUESTION_SUMMARY = "Ask the user to answer a question.";

const QUESTION_DETAILS = `## Inputs

| Field | Contract |
| --- | --- |
| \`message\` | The question shown to the user (non-empty string). |
| \`requestedSchema\` | JSON Schema object the user's answer must satisfy; \`enum\`/enumNames/oneOf/array/boolean/string/number forms supported. |

The result is \`{ "action": "accept", "content": <answer> }\`, \`{ "action": "decline" }\`, or \`{ "action": "cancel" }\`; a waiting loop resumes when the answer arrives.`;

export const questionRegisteredTool: RuntimeRegisteredTool = {
    target: "question",
    summary: QUESTION_SUMMARY,
    traits: ["interaction"],
    invocation: {
        target: { role: "Plurnk tool", kind: "literal", required: true },
        body: { role: "MCP2 form-elicitation object", required: true, mimetype: "application/json" },
        inputSchema: QUESTION_INPUT_SCHEMA,
    },
    details: QUESTION_DETAILS,
    definition: {
        name: "question",
        description: `${QUESTION_SUMMARY}\n\n${QUESTION_DETAILS}`,
        inputSchema: QUESTION_INPUT_SCHEMA,
    },
};

export default class QuestionTool extends BaseExecutor {
    override get traits(): ReadonlyArray<string> {
        return ["interaction"];
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
        if (!isRecord(parsed) || typeof parsed.message !== "string" || parsed.message.length === 0
            || !isRecord(parsed.requestedSchema)) {
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
        // The interaction schema describes the answer, not this executor's output.
        const request = Validator.assertClientInteractionRequest({
            toolName: "question",
            mode: "form",
            message: parsed.message,
            requestedSchema: parsed.requestedSchema,
        });
        // {§session-ownership} An unsupported request is this operation's result.
        let resolution;
        try {
            resolution = await interact(request);
        } catch (cause) {
            if (!(cause instanceof OperationFailureError)) throw cause;
            setState("results", "errored");
            return cause.result;
        }
        write("results", `${JSON.stringify(resolution, null, 2)}\n`, "application/json");
        setState("results", "closed");
        return { status: 200, attrs: { action: resolution.action } };
    }
}
