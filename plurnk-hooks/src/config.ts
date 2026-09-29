import { Knob } from "@plurnk/plurnk-meta";

export interface HookConfig {
    readonly command: string;
    readonly args: string[];
    readonly events: ReadonlySet<string>;
    readonly timeoutMs: number;
    readonly concurrency: number;
    readonly queueLimit: number;
}

const hookArgs = (raw: string | undefined): string[] => {
    if (raw === undefined || raw.length === 0) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error("PLURNK_HOOKS_ARGS must be a JSON array of strings.", { cause });
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error("PLURNK_HOOKS_ARGS must be a JSON array of strings.");
    }
    return parsed;
};

const hookEvents = (raw: string | undefined): ReadonlySet<string> => {
    if (raw === undefined || raw.trim().length === 0) {
        throw new Error("PLURNK_HOOKS_EVENTS must select at least one event.");
    }
    const selected = new Set<string>();
    for (const event of raw.split(",").map((value) => value.trim())) {
        if (!/^[^\s,/*]+(?:\/[^\s,/*]+)+$/u.test(event)) throw new Error(`PLURNK_HOOKS_EVENTS requires exact event names; got '${event}'.`);
        if (selected.has(event)) {
            throw new Error(`PLURNK_HOOKS_EVENTS selects '${event}' more than once.`);
        }
        selected.add(event);
    }
    return selected;
};

export const hookConfig = (): HookConfig | null => {
    const environment = process.env;
    const timeoutMs = Knob.integer("PLURNK_HOOKS_TIMEOUT_MS", 1);
    const concurrency = Knob.integer("PLURNK_HOOKS_CONCURRENCY", 1);
    const queueLimit = Knob.integer("PLURNK_HOOKS_QUEUE_LIMIT", 0);
    const command = environment.PLURNK_HOOKS_COMMAND?.trim() ?? "";
    if (command.length === 0) {
        if (
            (environment.PLURNK_HOOKS_ARGS?.length ?? 0) > 0
            || (environment.PLURNK_HOOKS_EVENTS?.length ?? 0) > 0
        ) {
            throw new Error("PLURNK_HOOKS configuration has companions but no PLURNK_HOOKS_COMMAND.");
        }
        return null;
    }
    return {
        command,
        args: hookArgs(environment.PLURNK_HOOKS_ARGS),
        events: hookEvents(environment.PLURNK_HOOKS_EVENTS),
        timeoutMs,
        concurrency,
        queueLimit,
    };
};
