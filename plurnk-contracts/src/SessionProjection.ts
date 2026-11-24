// {§client-config-options} {§client-session-status} {§client-diagnostics}
// Browser/Node-neutral session config option flattener, 4-tier model ranker,
// session clock/phase projection, Problem summary formatter, and operation glyph summarizer.
import { isRecord } from "./guards.ts";
import type { ProblemDetails } from "./types.generated.ts";

export interface FlatConfigSelectOption {
    readonly value: string;
    readonly name: string;
    readonly description?: string;
    readonly groupId?: string;
    readonly groupName?: string;
}

export interface ParsedConfigOption {
    readonly id: string;
    readonly name: string;
    readonly category?: string;
    readonly currentValue: string | boolean;
    readonly options: readonly FlatConfigSelectOption[];
}

export interface ParsedSessionConfigOptions {
    readonly model: ParsedConfigOption | null;
    readonly child: ParsedConfigOption | null;
    readonly thoughtLevel: ParsedConfigOption | null;
    readonly mode: ParsedConfigOption | null;
    readonly persona: ParsedConfigOption | null;
    readonly familyToggles: readonly ParsedConfigOption[];
    readonly byId: ReadonlyMap<string, ParsedConfigOption>;
}

/**
 * {§client-config-options} Flattens ungrouped `SessionConfigSelectOption` items and grouped
 * ACPv2 `SessionConfigSelectGroup` (`{ groupId, name, options }`) items into one ordered option list.
 */
export const flattenConfigSelectOptions = (rawOptions: unknown): readonly FlatConfigSelectOption[] => {
    if (!Array.isArray(rawOptions)) return [];
    const flat: FlatConfigSelectOption[] = [];
    for (const entry of rawOptions) {
        if (!isRecord(entry)) continue;
        if (Array.isArray(entry.options)) {
            const groupId = typeof entry.groupId === "string" ? entry.groupId : undefined;
            const groupName =
                typeof entry.name === "string"
                    ? entry.name
                    : typeof entry.group === "string"
                      ? entry.group
                      : undefined;
            for (const sub of entry.options) {
                if (!isRecord(sub) || typeof sub.value !== "string") continue;
                flat.push({
                    value: sub.value,
                    name: typeof sub.name === "string" ? sub.name : sub.value,
                    ...(typeof sub.description === "string" ? { description: sub.description } : {}),
                    ...(groupId === undefined ? {} : { groupId }),
                    ...(groupName === undefined ? {} : { groupName }),
                });
            }
            continue;
        }
        if (typeof entry.value === "string") {
            flat.push({
                value: entry.value,
                name: typeof entry.name === "string" ? entry.name : entry.value,
                ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            });
        }
    }
    return flat;
};

/**
 * {§client-config-options} Parses ACPv2 `configOptions` once into canonical session selectors
 * (`model`, `child`, `thought_level`, `mode`, `persona`) and `<family>:<alias>` toggles.
 */
export const parseSessionConfigOptions = (rawConfigOptions: unknown): ParsedSessionConfigOptions => {
    const byId = new Map<string, ParsedConfigOption>();
    const familyToggles: ParsedConfigOption[] = [];

    if (Array.isArray(rawConfigOptions)) {
        for (const item of rawConfigOptions) {
            if (!isRecord(item) || typeof item.id !== "string") continue;
            const currentValue =
                typeof item.currentValue === "string" || typeof item.currentValue === "boolean"
                    ? item.currentValue
                    : "";
            const parsed: ParsedConfigOption = {
                id: item.id,
                name: typeof item.name === "string" ? item.name : item.id,
                ...(typeof item.category === "string" ? { category: item.category } : {}),
                currentValue,
                options: flattenConfigSelectOptions(item.options),
            };
            byId.set(parsed.id, parsed);
            if (parsed.id.includes(":")) {
                familyToggles.push(parsed);
            }
        }
    }

    return {
        model: byId.get("model") ?? null,
        child: byId.get("child") ?? null,
        thoughtLevel: byId.get("thought_level") ?? null,
        mode: byId.get("mode") ?? null,
        persona: byId.get("persona") ?? null,
        familyToggles,
        byId,
    };
};

export interface ModelChoiceCandidate {
    readonly selector: string;
    readonly kind: "alias" | "catalog";
    readonly label?: string;
    readonly supportedEfforts?: readonly string[];
}

/**
 * {§client-config-options} Ranks model selectors deterministically across 4 tiers:
 * 0 = exact alias, 1 = prefix alias, 2 = exact `provider/model`, 3 = prefix `provider/model`, 4 = substring match.
 */
export const rankModelChoices = (
    query: string,
    candidates: readonly ModelChoiceCandidate[],
): readonly ModelChoiceCandidate[] => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
        return [...candidates].toSorted((a, b) => {
            if (a.kind !== b.kind) return a.kind === "alias" ? -1 : 1;
            return a.selector.localeCompare(b.selector);
        });
    }
    const scored: Array<{ readonly tier: number; readonly candidate: ModelChoiceCandidate }> = [];
    for (const candidate of candidates) {
        const lower = candidate.selector.toLowerCase();
        const labelLower = candidate.label?.toLowerCase() ?? "";
        let tier = -1;
        if (candidate.kind === "alias" && lower === needle) tier = 0;
        else if (candidate.kind === "alias" && lower.startsWith(needle)) tier = 1;
        else if (lower === needle) tier = 2;
        else if (lower.startsWith(needle)) tier = 3;
        else if (lower.includes(needle) || labelLower.includes(needle)) tier = 4;
        if (tier >= 0) scored.push({ tier, candidate });
    }
    return scored
        .toSorted((a, b) => a.tier - b.tier || a.candidate.selector.localeCompare(b.candidate.selector))
        .map((s) => s.candidate);
};

export type SessionPhase =
    | "idle"
    | "queued"
    | "awaiting_model"
    | "running"
    | "parked"
    | "requires_action";

export interface SessionStatusInput {
    readonly lifecycle?: string | null;
    readonly turnPhase?: string | null;
    readonly pendingGateCount?: number;
    readonly claimedAt?: number | null;
    readonly terminatedAt?: number | null;
    readonly waitUntil?: number | null;
    readonly inboxCount?: number;
    readonly activeStreamCount?: number;
}

export interface ProjectedSessionStatus {
    readonly phase: SessionPhase;
    readonly elapsedMs: number | null;
    readonly waitRemainingMs: number | null;
    readonly inboxCount: number;
    readonly activeStreamCount: number;
}

/**
 * {§client-session-status} Projects session phase, daemon `claimedAt`/`terminatedAt` elapsed duration,
 * and parked countdown from `_meta.plurnk.status` + runtime telemetry.
 */
export const projectSessionStatus = (
    input: SessionStatusInput,
    nowMs = Date.now(),
): ProjectedSessionStatus => {
    const lifecycle = input.lifecycle ?? "idle";
    const pendingGates = input.pendingGateCount ?? 0;

    let phase: SessionPhase = "idle";
    if (pendingGates > 0 || lifecycle === "requires_action") {
        phase = "requires_action";
    } else if (lifecycle === "parked") {
        phase = "parked";
    } else if (lifecycle === "queued" || input.turnPhase === "turn_queued") {
        phase = "queued";
    } else if (lifecycle === "running") {
        phase = input.turnPhase === "turn_awaiting_model" ? "awaiting_model" : "running";
    }

    let elapsedMs: number | null = null;
    if (typeof input.claimedAt === "number" && Number.isFinite(input.claimedAt) && input.claimedAt > 0) {
        const endMs =
            typeof input.terminatedAt === "number" && Number.isFinite(input.terminatedAt) && input.terminatedAt >= input.claimedAt
                ? input.terminatedAt
                : nowMs;
        elapsedMs = Math.max(0, endMs - input.claimedAt);
    }

    const waitRemainingMs =
        phase === "parked" && typeof input.waitUntil === "number" && Number.isFinite(input.waitUntil)
            ? Math.max(0, input.waitUntil - nowMs)
            : null;

    return {
        phase,
        elapsedMs,
        waitRemainingMs,
        inboxCount: input.inboxCount ?? 0,
        activeStreamCount: input.activeStreamCount ?? 0,
    };
};

/**
 * {§client-diagnostics} {§diagnostic-observation} Formats an RFC 9457 Problem without dropping
 * `detail` or `recovery` when `title` is present.
 */
export const formatProblemSummary = (rawProblem: Partial<ProblemDetails> | Record<string, unknown> | null | undefined): string => {
    if (!isRecord(rawProblem)) return "";
    const title = typeof rawProblem.title === "string" ? rawProblem.title.trim() : "";
    const detail = typeof rawProblem.detail === "string" ? rawProblem.detail.trim() : "";
    const recovery = typeof rawProblem.recovery === "string" ? rawProblem.recovery.trim() : "";

    const parts: string[] = [];
    if (title.length > 0 && detail.length > 0) {
        parts.push(detail.toLowerCase().startsWith(title.toLowerCase()) ? detail : `${title}: ${detail}`);
    } else if (detail.length > 0) {
        parts.push(detail);
    } else if (title.length > 0) {
        parts.push(title);
    }
    if (recovery.length > 0) {
        parts.push(recovery.startsWith("Recovery:") ? recovery : `Recovery: ${recovery}`);
    }
    return parts.join("\n");
};

const OPERATION_GLYPHS: Readonly<Record<string, string>> = Object.freeze({
    find: "⌕",
    read: "📖",
    edit: "✎",
    copy: "⎘",
    move: "⇄",
    kill: "✕",
    work: "⑂",
    fork: "⑃",
    send: "✉",
    wait: "⏳",
    note: "📝",
    done: "✓",
    fail: "✗",
    bare: "◌",
    sh: "$",
    js: "λ",
    python3: "🐍",
});

export interface OperationSummary {
    readonly glyph: string;
    readonly verb: string;
    readonly target: string | null;
    readonly curated: boolean;
    readonly headline: string;
}

/**
 * {§client-diagnostics} Produces canonical glyph, primary target, curation mark (`log:///` `kill`),
 * and single-line headline for an operation row across CLI, Term, and Web.
 */
export const summarizeOperation = (args: {
    readonly op: string | null | undefined;
    readonly target?: string | null;
    readonly aside?: string | null;
    readonly attrs?: Readonly<Record<string, unknown>> | null;
}): OperationSummary => {
    const verb = typeof args.op === "string" && args.op.length > 0 ? args.op.toLowerCase() : "op";
    const glyph = OPERATION_GLYPHS[verb] ?? "•";
    const attrs = args.attrs ?? null;
    const primaryTarget =
        (typeof args.target === "string" && args.target.length > 0 ? args.target : null)
        ?? (attrs !== null && typeof attrs.destination === "string" && attrs.destination.length > 0 ? attrs.destination : null)
        ?? (attrs !== null && typeof attrs.pathname === "string" && attrs.pathname.length > 0 ? attrs.pathname : null);
    const curated = verb === "kill" && primaryTarget !== null && primaryTarget.startsWith("log:///");
    const aside = typeof args.aside === "string" && args.aside.trim().length > 0 ? args.aside.trim() : null;
    const label = primaryTarget !== null ? `${verb} ${primaryTarget}` : verb;
    const headline = aside !== null ? `${glyph} ${label} — ${aside}` : `${glyph} ${label}`;
    return {
        glyph,
        verb,
        target: primaryTarget,
        curated,
        headline,
    };
};
