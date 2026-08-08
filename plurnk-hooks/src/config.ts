export const HOOK_EVENTS = [
    "log/entry",
    "loop/proposal",
    "loop/terminated",
    "notice/event",
    "stream/concluded",
    "stream/event",
    "workspace/branch-batch",
    "workspace/created",
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export interface HookConfig {
    readonly command: string;
    readonly args: string[];
    readonly events: ReadonlySet<HookEvent>;
    readonly timeoutMs: number;
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

const hookEvents = (raw: string | undefined): ReadonlySet<HookEvent> => {
    if (raw === undefined || raw.trim().length === 0) {
        throw new Error("PLURNK_HOOKS_EVENTS must select at least one event.");
    }
    const known = new Set<string>(HOOK_EVENTS);
    const selected = new Set<HookEvent>();
    for (const event of raw.split(",").map((value) => value.trim())) {
        if (!known.has(event)) throw new Error(`PLURNK_HOOKS_EVENTS names unknown core event '${event}'.`);
        if (selected.has(event as HookEvent)) {
            throw new Error(`PLURNK_HOOKS_EVENTS selects '${event}' more than once.`);
        }
        selected.add(event as HookEvent);
    }
    return selected;
};

const hookTimeoutMs = (raw: string | undefined): number => {
    const timeoutMs = Number(raw);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error(`PLURNK_HOOKS_TIMEOUT_MS must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return timeoutMs;
};

export const hookConfig = (environment: NodeJS.ProcessEnv = process.env): HookConfig | null => {
    const timeoutMs = hookTimeoutMs(environment.PLURNK_HOOKS_TIMEOUT_MS);
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
    if (/\s/.test(command)) {
        throw new Error("PLURNK_HOOKS_COMMAND must contain one executable; put arguments in PLURNK_HOOKS_ARGS.");
    }
    return {
        command,
        args: hookArgs(environment.PLURNK_HOOKS_ARGS),
        events: hookEvents(environment.PLURNK_HOOKS_EVENTS),
        timeoutMs,
    };
};
