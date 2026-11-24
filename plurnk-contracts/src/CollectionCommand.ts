// {§client-collection-browsing} {§client-family-commands}
// Shared list/discover query flag parsers, usage errors, and pagination footers across CLI, Term, and Web.
import Problems from "./Problems.ts";
import type { ProblemDetails } from "./types.generated.ts";

export const LIST_STATES = Object.freeze([
    "disabled",
    "dormant",
    "active",
    "unavailable",
    "authorization-required",
] as const);

export const LIST_ORIGINS = Object.freeze(["service", "workspace", "session"] as const);

export const FAMILY_LIST_FLAGS: readonly { readonly value: string; readonly description: string }[] = Object.freeze([
    { value: "--query", description: "Filter definitions by substring" },
    { value: "--state", description: "Filter by state (active, disabled, dormant, unavailable, authorization-required)" },
    { value: "--origin", description: "Filter by origin (service, workspace, session)" },
    { value: "--offset", description: "Skip the first N matching definitions" },
    { value: "--limit", description: "Maximum definitions per page (1..100)" },
]);

export const FAMILY_DISCOVER_FLAGS_BY_FAMILY: Readonly<
    Record<string, readonly { readonly value: string; readonly description: string }[]>
> = Object.freeze({
    mcp: Object.freeze([
        { value: "--query", description: "Search MCP Registry by server name" },
        { value: "--cursor", description: "Continue from a previous page cursor" },
        { value: "--limit", description: "Maximum candidates per page (1..100)" },
    ]),
    skills: Object.freeze([
        { value: "--source", description: "Skill source (git URL, path, archive, or <server>:///skills)" },
        { value: "--query", description: "Filter discovered skills by name or description" },
        { value: "--cursor", description: "Continue from a previous page cursor" },
        { value: "--limit", description: "Maximum candidates per page (1..100)" },
    ]),
    personas: Object.freeze([
        { value: "--source", description: "Inspect a persona file or directory" },
        { value: "--query", description: "Filter discovered personas by name or description" },
        { value: "--cursor", description: "Continue from a previous page cursor" },
        { value: "--limit", description: "Maximum candidates per page (1..100)" },
    ]),
    env: Object.freeze([
        { value: "--query", description: "Filter variables by name or comment" },
        { value: "--source", description: "Filter by declaring package or .env.example" },
        { value: "--cursor", description: "Continue from a previous page cursor" },
        { value: "--limit", description: "Maximum candidates per page (1..100)" },
    ]),
    members: Object.freeze([
        { value: "--query", description: "Path or glob to preview" },
        { value: "--limit", description: "Maximum preview paths to return (1..100)" },
    ]),
    schedule: Object.freeze([
        { value: "--rule", description: "Preview occurrences of a cron, RRULE, +duration, or ISO rule" },
        { value: "--cursor", description: "Continue from a previous page cursor" },
        { value: "--limit", description: "Maximum candidates per page (1..100)" },
    ]),
});

export const MODELS_LIST_FLAGS: readonly { readonly value: string; readonly description: string }[] = Object.freeze([
    { value: "--provider", description: "Filter catalog models by provider id" },
    { value: "--all", description: "Include unconfigured providers and models" },
    { value: "--offset", description: "Skip the first N matching models" },
    { value: "--limit", description: "Maximum models per page (1..100)" },
]);

class CollectionUsageError extends Error {
    readonly problem: ProblemDetails;

    constructor(title: string, detail: string) {
        super(detail);
        this.name = "CollectionUsageError";
        this.problem = Problems.create("client", "usage", 400, detail, {}, { title });
    }
}

const usageError = (title: string, detail: string): Error => new CollectionUsageError(title, detail);

const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
        throw usageError("Missing option value", `${flag} requires a value.`);
    }
    return value;
};

const parseIntegerOption = (flag: string, raw: string, min: number, max: number): number => {
    if (!/^\d+$/u.test(raw.trim())) {
        throw usageError(`Invalid ${flag}`, `${flag} must be an integer between ${String(min)} and ${String(max)}.`);
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw usageError(`Invalid ${flag}`, `${flag} must be an integer between ${String(min)} and ${String(max)}.`);
    }
    return parsed;
};

/**
 * {§client-collection-browsing} Parses bounded list filters (`[query...]`, `--query`, `--state`, `--origin`,
 * `--offset`, `--limit`) uniformly for every Functionality family.
 */
export const parseFamilyListArgs = (rest: readonly string[]): Record<string, unknown> => {
    let queryFlag: string | undefined;
    let stateFlag: string | undefined;
    let originFlag: string | undefined;
    let offsetFlag: number | undefined;
    let limitFlag: number | undefined;
    const posArgs: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
        const tok = rest[i] ?? "";
        if (tok === "--query") {
            queryFlag = requireValue("--query", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--query=")) {
            queryFlag = tok.slice("--query=".length);
        } else if (tok === "--state") {
            stateFlag = requireValue("--state", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--state=")) {
            stateFlag = tok.slice("--state=".length);
        } else if (tok === "--origin") {
            originFlag = requireValue("--origin", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--origin=")) {
            originFlag = tok.slice("--origin=".length);
        } else if (tok === "--offset") {
            offsetFlag = parseIntegerOption("--offset", requireValue("--offset", rest[i + 1]), 0, Number.MAX_SAFE_INTEGER);
            i += 1;
        } else if (tok.startsWith("--offset=")) {
            offsetFlag = parseIntegerOption("--offset", tok.slice("--offset=".length), 0, Number.MAX_SAFE_INTEGER);
        } else if (tok === "--limit") {
            limitFlag = parseIntegerOption("--limit", requireValue("--limit", rest[i + 1]), 1, 100);
            i += 1;
        } else if (tok.startsWith("--limit=")) {
            limitFlag = parseIntegerOption("--limit", tok.slice("--limit=".length), 1, 100);
        } else {
            posArgs.push(tok);
        }
    }

    if (stateFlag !== undefined && !(LIST_STATES as readonly string[]).includes(stateFlag)) {
        throw usageError("Invalid --state", `--state must be one of: ${LIST_STATES.join(", ")}.`);
    }
    if (originFlag !== undefined && !(LIST_ORIGINS as readonly string[]).includes(originFlag)) {
        throw usageError("Invalid --origin", `--origin must be one of: ${LIST_ORIGINS.join(", ")}.`);
    }
    const resolvedQuery = queryFlag ?? (posArgs.length > 0 ? posArgs.join(" ") : undefined);
    return {
        ...(resolvedQuery !== undefined && resolvedQuery.length > 0 ? { query: resolvedQuery } : {}),
        ...(stateFlag !== undefined ? { state: stateFlag } : {}),
        ...(originFlag !== undefined ? { origin: originFlag } : {}),
        ...(offsetFlag !== undefined ? { offset: offsetFlag } : {}),
        ...(limitFlag !== undefined ? { limit: limitFlag } : {}),
    };
};

/**
 * {§client-collection-browsing} Parses discovery filters and cursor pagination (`--source`, `--query`, `--rule`,
 * `--cursor`, `--limit`, plus family-specific positional arguments) uniformly across families.
 */
export const parseFamilyDiscoverArgs = (family: string, rest: readonly string[]): Record<string, unknown> => {
    let sourceFlag: string | undefined;
    let queryFlag: string | undefined;
    let ruleFlag: string | undefined;
    let cursorFlag: string | undefined;
    let limitFlag: number | undefined;
    const posArgs: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
        const tok = rest[i] ?? "";
        if (tok === "--source") {
            sourceFlag = requireValue("--source", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--source=")) {
            sourceFlag = tok.slice("--source=".length);
        } else if (tok === "--query") {
            queryFlag = requireValue("--query", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--query=")) {
            queryFlag = tok.slice("--query=".length);
        } else if (tok === "--rule") {
            ruleFlag = requireValue("--rule", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--rule=")) {
            ruleFlag = tok.slice("--rule=".length);
        } else if (tok === "--cursor") {
            cursorFlag = requireValue("--cursor", rest[i + 1]);
            i += 1;
        } else if (tok.startsWith("--cursor=")) {
            cursorFlag = tok.slice("--cursor=".length);
        } else if (tok === "--limit") {
            limitFlag = parseIntegerOption("--limit", requireValue("--limit", rest[i + 1]), 1, 100);
            i += 1;
        } else if (tok.startsWith("--limit=")) {
            limitFlag = parseIntegerOption("--limit", tok.slice("--limit=".length), 1, 100);
        } else {
            posArgs.push(tok);
        }
    }

    if (posArgs.length > 0) {
        if (family === "skills") {
            if (sourceFlag === undefined) {
                sourceFlag = posArgs[0];
                if (queryFlag === undefined && posArgs.length > 1) {
                    queryFlag = posArgs.slice(1).join(" ");
                }
            } else if (queryFlag === undefined) {
                queryFlag = posArgs.join(" ");
            }
        } else if (family === "personas") {
            if (sourceFlag === undefined && queryFlag === undefined) {
                sourceFlag = posArgs.join(" ");
            } else if (queryFlag === undefined) {
                queryFlag = posArgs.join(" ");
            }
        } else if (family === "schedule") {
            if (ruleFlag === undefined) {
                ruleFlag = posArgs.join(" ");
            }
        } else if (queryFlag === undefined) {
            queryFlag = posArgs.join(" ");
        }
    }

    return {
        ...(sourceFlag !== undefined && sourceFlag.length > 0 ? { source: sourceFlag } : {}),
        ...(queryFlag !== undefined && queryFlag.length > 0 ? { query: queryFlag } : {}),
        ...(ruleFlag !== undefined && ruleFlag.length > 0 ? { rule: ruleFlag } : {}),
        ...(cursorFlag !== undefined && cursorFlag.length > 0 ? { cursor: cursorFlag } : {}),
        ...(limitFlag !== undefined ? { limit: limitFlag } : {}),
    };
};

/**
 * {§client-collection-browsing} Formats a concise pagination footer for sliced/paged `FunctionalityListResult` pages.
 */
export const formatListPageFooter = (result: Readonly<Record<string, unknown>>): string | null => {
    const total = typeof result.total === "number" ? result.total : undefined;
    if (total === undefined) return null;
    const count = Array.isArray(result.definitions) ? result.definitions.length : 0;
    const offset = typeof result.offset === "number" ? result.offset : 0;
    const nextOffset = typeof result.nextOffset === "number" ? result.nextOffset : undefined;
    if (nextOffset === undefined && offset === 0 && count === total) {
        return null;
    }
    if (count === 0) {
        return `Showing 0 of ${String(total)}`;
    }
    const start = offset + 1;
    const end = offset + count;
    const nextHint = nextOffset !== undefined ? ` (next: --offset ${String(nextOffset)})` : "";
    return `Showing ${String(start)}–${String(end)} of ${String(total)}${nextHint}`;
};

/**
 * {§client-collection-browsing} Formats a concise pagination footer for sliced/paged `FunctionalityDiscoverResult` pages.
 */
export const formatDiscoverPageFooter = (result: Readonly<Record<string, unknown>>): string | null => {
    const count = Array.isArray(result.candidates) ? result.candidates.length : 0;
    const total = typeof result.total === "number" ? result.total : undefined;
    const nextCursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
    if (nextCursor !== undefined) {
        const range = total !== undefined ? `Showing ${String(count)} of ${String(total)}` : `Showing ${String(count)}`;
        return `${range} (next: --cursor ${nextCursor})`;
    }
    if (total !== undefined && count < total) {
        return `Showing ${String(count)} of ${String(total)}`;
    }
    return null;
};
