import { BaseExecutor, Results } from "@plurnk/plurnk-execs";
import type {
    ChannelDecl,
    Effect,
    ExecArgs,
    ExecResult,
    ExecutorMetadata,
    RuntimeAvailability,
    RuntimeRegisteredTool,
} from "@plurnk/plurnk-execs";
import { Validator, isRecord, type JsonSchema } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../core/results.ts";

// {§question-tool} — the native request-user-input tool on the `plurnk` runtime.
// The model asks the human through `plurnk.question`, wired directly against the
// standard client-interaction lifecycle (no loopback MCP, no proposal masquerade).
// High-level `{ message, options?, multi? }`, `{ questions: [...] }`, and free-text
// `{ message }` lower deterministically to the ACPv2 / MCP2 2026-07-28 form-elicitation
// shape `{ message, requestedSchema }`, and the result is the standard
// `ElicitResult` (`{ action: "accept" | "decline" | "cancel", content? }`).
// Effect `read`: the tool observes the human's answer and never mutates the host,
// so it is never proposal-gated.

const QUESTION_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
        text: {
            type: "string",
            minLength: 1,
            description: "The question shown to the user (non-empty string).",
        },
        options: {
            type: "array",
            minItems: 1,
            items: {
                oneOf: [
                    { type: "string", minLength: 1 },
                    {
                        type: "object",
                        required: ["value"],
                        additionalProperties: false,
                        properties: {
                            value: { type: "string", minLength: 1 },
                            title: { type: "string" },
                            description: { type: "string" },
                        },
                    },
                ],
            },
            description: "Optional multiple-choice options (strings or { value, title?, description? }).",
        },
        multi: {
            type: "boolean",
            description: "Allow selecting multiple options when true (single-select by default).",
        },
        schema: {
            type: "object",
            description: "Optional JSON Schema object ({ type: \"object\", properties, required? }) the user's answer must satisfy.",
        },
    },
} as const satisfies JsonSchema;

const QUESTION_SUMMARY = "Ask the user to answer a question.";

const QUESTION_DETAILS = `## Inputs

| Field | Contract |
| --- | --- |
| \`text\` | The question shown to the user (non-empty string). |
| \`options\` | Optional multiple-choice options (\`string\` or \`{ value, title?, description? }\`). |
| \`multi\` | Optional \`true\` to allow selecting multiple options (\`false\` by default). |
| \`schema\` | Optional JSON Schema object (\`{ type: "object", properties, required? }\`) the user's answer must satisfy. |

The result is \`{ "action": "accept", "content": <answer> }\`, \`{ "action": "decline" }\`, or \`{ "action": "cancel" }\`; a waiting loop resumes when the answer arrives.`;

const lowerOptionsProperty = (
    options: readonly unknown[],
    multi: boolean,
    title?: string,
): Record<string, unknown> | null => {
    if (options.length === 0) return null;
    const normalized: Array<{ value: string; title?: string; description?: string }> = [];
    let hasRichMetadata = false;
    for (const item of options) {
        if (typeof item === "string") {
            if (item.length === 0) return null;
            normalized.push({ value: item });
            continue;
        }
        if (isRecord(item)) {
            const rawVal = item.value ?? item.id ?? item.label ?? item.title;
            if (typeof rawVal !== "string" || rawVal.length === 0) return null;
            const itemTitle = typeof item.title === "string" && item.title.length > 0
                ? item.title
                : (typeof item.label === "string" && item.label.length > 0 ? item.label : undefined);
            const itemDesc = typeof item.description === "string" && item.description.length > 0
                ? item.description
                : undefined;
            if ((itemTitle !== undefined && itemTitle !== rawVal) || itemDesc !== undefined) {
                hasRichMetadata = true;
            }
            normalized.push({
                value: rawVal,
                ...(itemTitle === undefined ? {} : { title: itemTitle }),
                ...(itemDesc === undefined ? {} : { description: itemDesc }),
            });
            continue;
        }
        return null;
    }
    const titleProp = title === undefined ? {} : { title };
    if (!hasRichMetadata) {
        const values = normalized.map((opt) => opt.value);
        if (multi) {
            return {
                type: "array",
                ...titleProp,
                minItems: 1,
                uniqueItems: true,
                items: { type: "string", enum: values },
            };
        }
        return { type: "string", ...titleProp, enum: values };
    }
    const choices = normalized.map((opt) => ({
        const: opt.value,
        title: opt.title ?? opt.value,
        ...(opt.description === undefined ? {} : { description: opt.description }),
    }));
    if (multi) {
        return {
            type: "array",
            ...titleProp,
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", anyOf: choices },
        };
    }
    return { type: "string", ...titleProp, oneOf: choices };
};

const lowerQuestionInput = (parsed: unknown): { message: string; requestedSchema: Record<string, unknown> } | null => {
    if (!isRecord(parsed)) return null;
    if (Array.isArray(parsed.questions)) {
        if (parsed.questions.length === 0) return null;
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        const messages: string[] = [];
        for (const [idx, q] of parsed.questions.entries()) {
            if (!isRecord(q)) return null;
            const rawQText = q.text ?? q.question ?? q.message ?? q.prompt ?? q.content ?? q.body;
            if (typeof rawQText !== "string" || rawQText.length === 0) return null;
            messages.push(rawQText);
            const key = typeof q.header === "string" && q.header.trim().length > 0
                ? q.header.trim()
                : (typeof q.id === "string" && q.id.trim().length > 0
                    ? q.id.trim()
                    : (parsed.questions.length === 1 ? "answer" : `q${idx + 1}`));
            const rawOpts = q.options ?? q.choices;
            const isMulti = (q.multi ?? q.multiSelect ?? q.is_multi_select) === true;
            if (rawOpts !== undefined) {
                if (!Array.isArray(rawOpts)) return null;
                const prop = lowerOptionsProperty(rawOpts, isMulti, rawQText);
                if (prop === null) return null;
                properties[key] = prop;
            } else {
                properties[key] = { type: "string", title: rawQText };
            }
            required.push(key);
        }
        const rawTopMsg = parsed.text ?? parsed.message ?? parsed.question ?? parsed.prompt ?? parsed.content ?? parsed.body;
        const message = typeof rawTopMsg === "string" && rawTopMsg.length > 0
            ? rawTopMsg
            : messages.join("\n");
        return {
            message,
            requestedSchema: { type: "object", properties, required },
        };
    }
    const rawMsg = parsed.text ?? parsed.message ?? parsed.question ?? parsed.prompt ?? parsed.content ?? parsed.body;
    if (typeof rawMsg !== "string" || rawMsg.length === 0) return null;
    const rawSchema = parsed.schema ?? parsed.requestedSchema;
    if (rawSchema !== undefined) {
        if (!isRecord(rawSchema) || Object.keys(rawSchema).length === 0) return null;
        return { message: rawMsg, requestedSchema: rawSchema };
    }
    const rawOptions = parsed.options ?? parsed.choices;
    if (rawOptions !== undefined) {
        if (!Array.isArray(rawOptions)) return null;
        const isMulti = (parsed.multi ?? parsed.multiSelect ?? parsed.is_multi_select) === true;
        const prop = lowerOptionsProperty(rawOptions, isMulti);
        if (prop === null) return null;
        return {
            message: rawMsg,
            requestedSchema: {
                type: "object",
                properties: { answer: prop },
                required: ["answer"],
            },
        };
    }
    return {
        message: rawMsg,
        requestedSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
        },
    };
};

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
    constructor(metadata: ExecutorMetadata = { runtime: "plurnk", glyph: "🔌" }) {
        super(metadata);
    }

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
        const lowered = lowerQuestionInput(parsed);
        if (lowered === null) {
            setState("results", "errored");
            return Results.failure(
                "executor:question",
                "invalid-body",
                400,
                "The question body must carry a non-empty message (and valid options or schema when supplied).",
                {},
                { recovery: "Use `await plurnk.question({ text: \"...\", options: [\"...\"] });` or `{ text, schema }`.", retryable: false },
            );
        }
        signal.throwIfAborted();
        // The interaction schema describes the answer, not this executor's output.
        const request = Validator.assertClientInteractionRequest({
            toolName: "question",
            mode: "form",
            message: lowered.message,
            requestedSchema: lowered.requestedSchema,
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
