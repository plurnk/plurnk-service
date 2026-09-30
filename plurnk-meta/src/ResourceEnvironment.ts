import Knob from "./Knob.ts";

interface EnvironmentValue {
    readonly key: string;
    readonly value: string;
}

// {§resource-environment}: syntax and independent controls only. Families own definition schemas.
export default class ResourceEnvironment {
    readonly definitions: ReadonlyMap<string, EnvironmentValue>;
    readonly #settings = new Map<string, Map<string, EnvironmentValue>>();
    readonly #enabled = new Map<string, boolean>();
    readonly #defaultEnabled: boolean;

    constructor(
        prefix: string,
        vocabulary: { readonly controls: readonly string[]; readonly settings: readonly string[]; readonly aliasPattern?: RegExp },
        environment: Readonly<Record<string, string | undefined>> = process.env,
    ) {
        this.#defaultEnabled = Knob.flag(`${prefix}ENABLED`, environment);
        const controls = new Set(["ENABLED", ...vocabulary.controls]);
        const settings = new Set(["ENABLED", ...vocabulary.settings]);
        const aliasPattern = vocabulary.aliasPattern ?? /^[a-z][a-z0-9-]*$/u;
        const definitions = new Map<string, EnvironmentValue>();
        for (const [key, value] of Object.entries(environment)) {
            if (value === undefined || !key.startsWith(prefix)) continue;
            const suffix = key.slice(prefix.length);
            if (controls.has(suffix)) continue;
            const match = /^(.+?)(?:_([A-Z][A-Z0-9_]*))?$/u.exec(suffix);
            if (match === null || /[A-Z-]/u.test(match[1]) || !aliasPattern.test(match[1].replaceAll("_", "-"))) {
                throw new Error(`${key} is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.`);
            }
            const alias = match[1].replaceAll("_", "-");
            const setting = match[2];
            if (setting === undefined) {
                if (value.trim().length === 0) {
                    throw new Error(`${key} must contain a definition; use ${key}_ENABLED=0 to disable a defined resource.`);
                }
                definitions.set(alias, { key, value });
                continue;
            }
            if (!settings.has(setting)) throw new Error(`${key} names unsupported resource setting '${setting}'.`);
            const fields = this.#settings.get(alias) ?? new Map<string, EnvironmentValue>();
            fields.set(setting, { key, value });
            this.#settings.set(alias, fields);
            if (setting === "ENABLED") this.#enabled.set(alias, Knob.flag(key, environment));
        }
        this.definitions = new Map([...definitions].toSorted(([left], [right]) => left.localeCompare(right)));
    }

    enabled(alias: string): boolean {
        return this.#enabled.get(alias) ?? this.#defaultEnabled;
    }

    settings(name: string): ReadonlyMap<string, EnvironmentValue> {
        return new Map([...this.#settings].flatMap(([alias, settings]) => {
            const field = settings.get(name);
            return field === undefined ? [] : [[alias, field] as const];
        }));
    }
}
