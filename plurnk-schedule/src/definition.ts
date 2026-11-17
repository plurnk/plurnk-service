// {§schedule-family} — dual schedule definitions: agentic `prompt` delivery to `session://<name>`
// (with optional `persona` when auto-created) or deterministic `_plurnk` statement execution (`run`),
// under `rule: string` (one-shot or recurring) or `rule: null` (unscheduled durable obligation).
import { Validator, SESSION_NAME, SKILL_NAME, type JsonSchema } from "@plurnk/plurnk-contracts";

export interface PromptScheduleDefinition {
    readonly rule: string | null;
    readonly target: string;
    readonly prompt: string;
    readonly persona?: string;
    readonly catchup?: boolean;
}

export interface ScriptScheduleDefinition {
    readonly rule: string | null;
    readonly run: string;
    readonly target?: string;
    readonly catchup?: boolean;
}

export type ScheduleDefinition = PromptScheduleDefinition | ScriptScheduleDefinition;

export const isScriptDefinition = (definition: ScheduleDefinition): definition is ScriptScheduleDefinition =>
    "run" in definition;

const TARGET = new RegExp(`^session://(${SESSION_NAME.source.slice(1, -1)})$`, "u");

const RULE_SCHEMA: JsonSchema = Object.freeze({
    type: ["string", "null"],
    minLength: 1,
    description: "5-field cron expression, RFC 5545 RRULE/DTSTART, one-shot ISO-8601 timestamp or +duration / PT... offset, or null for an unscheduled obligation.",
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
            required: ["rule", "target", "prompt"],
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
            required: ["rule", "run"],
            properties: {
                rule: RULE_SCHEMA,
                run: {
                    type: "string",
                    minLength: 1,
                    description: "Plurnk statement block executed deterministically in _plurnk without model inference.",
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
    return structuredClone(value as ScheduleDefinition);
};

export const targetSessionName = (target: string): string => {
    const match = TARGET.exec(target);
    if (match === null) throw new TypeError(`'${target}' is not a session:// target.`);
    return match[1];
};
