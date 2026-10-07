// {§schedule-family} — the one definition `add` accepts and the coordinator persists: the rule
// text ({§schedule-rule}), the worker the message is delivered to, and the message.
import { Validator, WORKER_NAME, type JsonSchema } from "@plurnk/plurnk-contracts";

export interface ScheduleDefinition {
    readonly rule: string;
    readonly target: string;
    readonly prompt: string;
}

const TARGET = new RegExp(`^worker://(${WORKER_NAME.source.slice(1, -1)})$`, "u");

export const DEFINITION_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["rule", "target", "prompt"],
    properties: {
        rule: {
            type: "string",
            minLength: 1,
            description: "RFC 5545 text: an optional DTSTART line and one RRULE line, or bare FREQ=… parts. A workspace rule ends: COUNT or UNTIL.",
        },
        target: {
            type: "string",
            pattern: TARGET.source,
            description: "The worker the message is delivered to.",
        },
        prompt: {
            type: "string",
            minLength: 1,
            description: "The message delivered at each occurrence.",
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
    return structuredClone(value as ScheduleDefinition);
};

export const targetWorkerName = (target: string): string => {
    const match = TARGET.exec(target);
    if (match === null) throw new TypeError(`'${target}' is not a worker:// target.`);
    return match[1]!;
};
