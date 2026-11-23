// {§schedule-family} — dual schedule definitions: agentic `prompt` delivery to `session://<name>`
// (with optional `persona` when auto-created) or deterministic `_plurnk` tool-call execution (`run`),
// under `rule: "manual"` (default when omitted; reusable), `rule: "once"` (unscheduled single-shot),
// or a timed RFC 5545 / cron / ISO-8601 / duration rule.
import {
    Validator,
    SESSION_NAME,
    SKILL_NAME,
    type JsonSchema,
    type ScheduledToolCall,
} from "@plurnk/plurnk-contracts";

export type { ScheduledToolCall };

export type UntimedRule = "manual" | "once";

export const isUntimedRule = (rule: string): rule is UntimedRule =>
    rule === "manual" || rule === "once";

interface PromptScheduleDefinition {
    readonly rule: string;
    readonly target: string;
    readonly prompt: string;
    readonly persona?: string;
    readonly catchup?: boolean;
}

export interface ScriptScheduleDefinition {
    readonly rule: string;
    readonly run: readonly ScheduledToolCall[];
    readonly target?: string;
    readonly catchup?: boolean;
}

export type ScheduleDefinition = PromptScheduleDefinition | ScriptScheduleDefinition;

export const isScriptDefinition = (definition: ScheduleDefinition): definition is ScriptScheduleDefinition =>
    "run" in definition;

const TARGET = new RegExp(`^session://(${SESSION_NAME.source.slice(1, -1)})$`, "u");

const RULE_SCHEMA: JsonSchema = Object.freeze({
    type: "string",
    minLength: 1,
    description: "'manual' (default when omitted; reusable on-demand trigger), 'once' (unscheduled single-shot obligation), 5-field cron expression, RFC 5545 RRULE/DTSTART, or one-shot ISO-8601 timestamp or +duration / PT... offset.",
});

const TARGET_SCHEMA: JsonSchema = Object.freeze({
    type: "string",
    pattern: TARGET.source,
    description: "The session:// target in this workspace.",
});

const CATCHUP_SCHEMA: JsonSchema = Object.freeze({
    type: "boolean",
    description: "Whether an occurrence missed while the daemon was offline fires once on wake (defaults to true for one-shot and daily/slower rules).",
});

const SCHEDULED_TOOL_CALL_SCHEMA: JsonSchema = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["server", "tool"],
    properties: {
        server: {
            type: "string",
            minLength: 1,
            description: "Target runtime or enabled MCP server (for example 'plurnk', 'sh', or an MCP server alias).",
        },
        tool: {
            type: "string",
            minLength: 1,
            description: "Tool name on the target server.",
        },
        arguments: {
            type: "object",
            description: "JSON object arguments passed to the tool call.",
        },
        aside: {
            type: "string",
            minLength: 1,
            description: "Optional short label recorded beside the operation.",
        },
    },
});

export const DEFINITION_SCHEMA = Object.freeze({
    oneOf: [
        { $ref: "#/$defs/promptSchedule" },
        { $ref: "#/$defs/scriptSchedule" },
    ],
    $defs: {
        promptSchedule: {
            title: "PromptSchedule",
            type: "object",
            additionalProperties: false,
            required: ["target", "prompt"],
            properties: {
                rule: RULE_SCHEMA,
                target: TARGET_SCHEMA,
                prompt: {
                    type: "string",
                    minLength: 1,
                    description: "The message delivered to the target session at each occurrence.",
                },
                persona: {
                    type: "string",
                    pattern: SKILL_NAME.source,
                    description: "Optional persona applied when auto-creating an absent target session.",
                },
                catchup: CATCHUP_SCHEMA,
            },
        },
        scriptSchedule: {
            title: "ScriptSchedule",
            type: "object",
            additionalProperties: false,
            required: ["run"],
            properties: {
                rule: RULE_SCHEMA,
                run: {
                    type: "array",
                    minItems: 1,
                    items: SCHEDULED_TOOL_CALL_SCHEMA,
                    description: "Ordered array of { server, tool, arguments?, aside? } calls executed deterministically in _plurnk without model inference.",
                },
                target: TARGET_SCHEMA,
                catchup: CATCHUP_SCHEMA,
            },
        },
    },
}) satisfies JsonSchema;

export class DefinitionError extends TypeError {
    readonly errors: readonly unknown[];

    constructor(errors: readonly unknown[]) {
        super("The schedule definition does not match its schema.");
        this.name = "DefinitionError";
        this.errors = errors;
    }
}

export const readDefinition = (value: unknown): ScheduleDefinition => {
    const validation = Validator.validateJsonSchemaInstance(DEFINITION_SCHEMA, value);
    if (!validation.valid) throw new DefinitionError(validation.errors);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the definition schema just proved the shape its type names
    const cloned = structuredClone(value as Partial<ScheduleDefinition> & Omit<ScheduleDefinition, "rule">);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rule defaults to 'manual' when omitted
    return {
        ...cloned,
        rule: cloned.rule ?? "manual",
    } as ScheduleDefinition;
};

export const targetSessionName = (target: string): string => {
    const match = TARGET.exec(target);
    if (match === null) throw new TypeError(`'${target}' is not a session:// target.`);
    return match[1];
};
