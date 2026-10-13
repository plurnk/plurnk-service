// {§tier-census} — what a specimen needs from its route, declared once on the specimen, checked
// before its body runs and named in the census when unmet. The vocabulary is closed so a census row
// reads the same across runs and routes.
import { resolveModel } from "@plurnk/plurnk-models";

export type InputModality = "image" | "pdf" | "audio" | "video";
export type LiveRequirement =
    | `input:${InputModality}`
    | "reasoning"
    | "output-budget"
    | `env:${string}`
    | `url:${string}`;

export interface RouteFacts {
    readonly inputModalities: ReadonlySet<string>;
    readonly supportedEfforts: readonly string[];
    readonly outputBudget: number | null;
}

export type ParsedRequirement =
    | { kind: "input"; modality: InputModality }
    | { kind: "reasoning" }
    | { kind: "output-budget" }
    | { kind: "env"; name: string }
    | { kind: "url"; url: string };

const MODALITIES: ReadonlySet<string> = new Set(["image", "pdf", "audio", "video"]);
const NO_REASONING: ReadonlySet<string> = new Set(["off", "adaptive"]);
const PROBE_TIMEOUT_MS = 10_000;

export const parseRequirement = (requirement: string): ParsedRequirement => {
    if (requirement === "reasoning") return { kind: "reasoning" };
    if (requirement === "output-budget") return { kind: "output-budget" };
    const colon = requirement.indexOf(":");
    const head = colon === -1 ? requirement : requirement.slice(0, colon);
    const rest = colon === -1 ? "" : requirement.slice(colon + 1);
    if (head === "input" && MODALITIES.has(rest)) return { kind: "input", modality: rest as InputModality };
    if (head === "env" && /^[A-Z][A-Z0-9_]*$/u.test(rest)) return { kind: "env", name: rest };
    if (head === "url" && /^https?:\/\//u.test(rest)) return { kind: "url", url: rest };
    throw new TypeError(`'${requirement}' is not a live requirement; the forms are input:<image|pdf|audio|video>, reasoning, output-budget, env:<NAME> and url:<http(s) URL>`);
};

// Whether a URL answers at all; the probe is a HEAD with a bounded wait and any response counts.
export const reachable = async (url: string): Promise<boolean> => {
    try {
        await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        return true;
    } catch {
        return false;
    }
};

export const needsRoute = (requirements: readonly LiveRequirement[]): boolean =>
    requirements.some((requirement) => ["input", "reasoning", "output-budget"].includes(parseRequirement(requirement).kind));

// Every unmet requirement, each as `requires <requirement>: <what was observed>`; empty when the
// specimen may run. `facts` is consulted only for the route-bound kinds.
export const unmetRequirements = async (
    requirements: readonly LiveRequirement[],
    facts: () => Promise<RouteFacts>,
    env: NodeJS.ProcessEnv = process.env,
    probe: (url: string) => Promise<boolean> = reachable,
): Promise<string[]> => {
    const unmet: string[] = [];
    for (const requirement of requirements) {
        const parsed = parseRequirement(requirement);
        let observed: string | null = null;
        switch (parsed.kind) {
            case "input": {
                const route = await facts();
                if (!route.inputModalities.has(parsed.modality)) observed = `the route advertises ${describeModalities(route.inputModalities)} input`;
                break;
            }
            case "reasoning": {
                const route = await facts();
                if (!route.supportedEfforts.some((effort) => !NO_REASONING.has(effort))) observed = `the route's efforts are ${route.supportedEfforts.join(", ")}`;
                break;
            }
            case "output-budget": {
                const route = await facts();
                if (route.outputBudget === null) observed = "the route resolved no output budget";
                break;
            }
            case "env":
                if (env[parsed.name] === undefined) observed = `${parsed.name} is not in the operator environment`;
                break;
            case "url":
                if (!(await probe(parsed.url))) observed = `${parsed.url} did not answer within ${PROBE_TIMEOUT_MS / 1000} s`;
                break;
        }
        if (observed !== null) unmet.push(`requires ${requirement}: ${observed}`);
    }
    return unmet;
};

const describeModalities = (modalities: ReadonlySet<string>): string =>
    modalities.size === 0 ? "text-only" : [...modalities].toSorted().join(", ");

// The requirements a census can read back out of a skip message.
export const requirementsOfSkip = (reason: string): LiveRequirement[] =>
    [...reason.matchAll(/(?:^|; )requires (\S+): /gu)].map((match) => match[1] as LiveRequirement);

// The declared aliases whose catalog entry satisfies a route-bound requirement; null for a
// requirement the catalog cannot answer (an environment key, a URL), and an uncataloged route never
// qualifies, as the provider it instantiates advertises nothing.
export const aliasesSatisfying = (
    requirement: LiveRequirement,
    aliases: readonly { readonly alias: string; readonly provider: string; readonly model: string }[],
): string[] | null => {
    const parsed = parseRequirement(requirement);
    if (parsed.kind === "env" || parsed.kind === "url") return null;
    return aliases.filter(({ provider, model }) => {
        const info = resolveModel(provider, model)?.info;
        if (info === undefined) return false;
        switch (parsed.kind) {
            case "input": return info.modalities.input.includes(parsed.modality);
            case "reasoning": return info.reasoning;
            case "output-budget": return true;
        }
    }).map(({ alias }) => alias).toSorted();
};
