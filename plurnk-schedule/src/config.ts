// {§schedule-environment} — the service's own rules: `PLURNK_SCHEDULE_<ALIAS>` holds one
// definition as JSON, the alias case-folded to the family grammar; `PLURNK_SCHEDULE_ENABLED`
// names the aliases a workspace starts with. Service rules may be unbounded ({§schedule-bound}).
import { readDefinition, DefinitionError, type ScheduleDefinition } from "./definition.ts";

const PREFIX = "PLURNK_SCHEDULE_";
export const ENABLED = `${PREFIX}ENABLED`;
const ALIAS = /^[a-z][a-z0-9-]*$/u;

const parseJson = (key: string, value: string): unknown => {
    try {
        return JSON.parse(value);
    } catch (cause) {
        throw new Error(`${key} is not JSON.`, { cause });
    }
};

export const serviceEnabled = (env: NodeJS.ProcessEnv): ReadonlySet<string> => {
    const raw = env[ENABLED];
    if (raw === undefined || raw.trim().length === 0) return new Set();
    const parsed = parseJson(ENABLED, raw);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
        throw new Error(`${ENABLED} must be a JSON array of aliases.`);
    }
    return new Set(parsed);
};

export const serviceDefinitions = (env: NodeJS.ProcessEnv): ReadonlyMap<string, ScheduleDefinition> => {
    const definitions = new Map<string, { key: string; definition: ScheduleDefinition }>();
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || !key.startsWith(PREFIX) || key === ENABLED) continue;
        const alias = key.slice(PREFIX.length).toLowerCase();
        if (!ALIAS.test(alias)) throw new Error(`${key} derives the alias '${alias}', which must match [a-z][a-z0-9-]*.`);
        const existing = definitions.get(alias);
        if (existing !== undefined) throw new Error(`${existing.key} and ${key} both derive the schedule alias '${alias}'.`);
        let definition: ScheduleDefinition;
        try {
            definition = readDefinition(parseJson(key, value));
        } catch (cause) {
            if (!(cause instanceof DefinitionError)) throw cause;
            throw new Error(`${key} must be a schedule definition: {"rule", "target", "prompt", "policy"?}.`, { cause });
        }
        definitions.set(alias, { key, definition });
    }
    return new Map([...definitions]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([alias, { definition }]) => [alias, definition]));
};
