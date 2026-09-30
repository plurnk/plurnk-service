// {§schedule-environment}
import { Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import { readDefinition, DefinitionError, type ScheduleDefinition } from "./definition.ts";
import { assertZone, normalizeRule } from "./rules.ts";

const PREFIX = "PLURNK_SCHEDULE_";
const PREVIEW_OCCURRENCES = `${PREFIX}PREVIEW_OCCURRENCES`;

const parseJson = (key: string, value: string): unknown => {
    try {
        return JSON.parse(value);
    } catch (cause) {
        throw new Error(`${key} is not JSON.`, { cause });
    }
};

// {§schedule-discovery-preview} — how many upcoming occurrences a reading of rule text shows.
export const previewOccurrences = (env: NodeJS.ProcessEnv): number => Knob.integer(PREVIEW_OCCURRENCES, 1, env);

export const serviceDefinitions = (env: NodeJS.ProcessEnv): ReadonlyMap<string, { readonly definition: ScheduleDefinition; readonly enabled: boolean }> => {
    const environment = new ResourceEnvironment(PREFIX, { controls: ["PREVIEW_OCCURRENCES"], settings: [] }, env);
    const definitions = new Map<string, { definition: ScheduleDefinition; enabled: boolean }>();
    for (const [alias, { key, value }] of environment.definitions) {
        let definition: ScheduleDefinition;
        try {
            definition = readDefinition(parseJson(key, value));
        } catch (cause) {
            if (!(cause instanceof DefinitionError)) throw cause;
            throw new Error(`${key} must be a schedule definition: {"rule", "target", "prompt", "policy"?}.`, { cause });
        }
        definitions.set(alias, { definition, enabled: environment.enabled(alias) });
    }
    return definitions;
};

export const validateConfiguration = (env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): ReturnType<typeof serviceDefinitions> => {
    const zone = env.TZ;
    if (zone === undefined || zone.length === 0) throw new Error("TZ is unset; @plurnk/plurnk-schedule declares its default in .env.defaults.");
    try {
        assertZone(zone);
    } catch (cause) {
        throw new Error("TZ must name a supported time zone.", { cause });
    }
    previewOccurrences(env);
    return new Map([...serviceDefinitions(env)].map(([alias, { definition, enabled }]) => {
        try {
            const parsed = normalizeRule(definition.rule, zone, nowMs);
            return [alias, { definition: { ...definition, rule: parsed.text }, enabled }];
        } catch (cause) {
            throw new Error(`PLURNK_SCHEDULE_${alias.replaceAll("-", "_")}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
    }));
};
