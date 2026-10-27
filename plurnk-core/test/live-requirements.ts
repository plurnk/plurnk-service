// {§test-artifact-retention} — what a specimen needs from its route and its host, declared once on the specimen,
// checked before its body runs and named in the census when unmet. The vocabulary is closed so a
// census row reads the same across runs, routes and hosts.
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { resolveModel } from "@plurnk/plurnk-models";

export type InputModality = "image" | "pdf" | "audio" | "video";
export type SiblingCheckout = "client";
export type LiveRequirement =
    | `input:${InputModality}`
    | "reasoning"
    | "output-budget"
    | `env:${string}`
    | `url:${string}`
    | `bin:${string}`
    | `checkout:${SiblingCheckout}`;

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
    | { kind: "url"; url: string }
    | { kind: "bin"; name: string }
    | { kind: "checkout"; name: SiblingCheckout };

// How the host is asked: each probe answers one requirement kind and is replaceable in a witness.
export interface HostProbes {
    readonly url: (url: string) => Promise<boolean>;
    readonly bin: (name: string) => boolean;
    readonly checkout: (name: SiblingCheckout, env: NodeJS.ProcessEnv) => string;
}

const MODALITIES: ReadonlySet<string> = new Set(["image", "pdf", "audio", "video"]);
const CHECKOUTS: ReadonlySet<string> = new Set(["client"]);
const NO_REASONING: ReadonlySet<string> = new Set(["off", "adaptive"]);
const PROBE_TIMEOUT_MS = 10_000;
const REPOSITORY = resolve(import.meta.dirname, "../..");

export const parseRequirement = (requirement: string): ParsedRequirement => {
    if (requirement === "reasoning") return { kind: "reasoning" };
    if (requirement === "output-budget") return { kind: "output-budget" };
    const colon = requirement.indexOf(":");
    const head = colon === -1 ? requirement : requirement.slice(0, colon);
    const rest = colon === -1 ? "" : requirement.slice(colon + 1);
    if (head === "input" && MODALITIES.has(rest)) return { kind: "input", modality: rest as InputModality };
    if (head === "env" && /^[A-Z][A-Z0-9_]*$/u.test(rest)) return { kind: "env", name: rest };
    if (head === "url" && /^https?:\/\//u.test(rest)) return { kind: "url", url: rest };
    if (head === "bin" && /^[a-z0-9][a-z0-9._-]*$/u.test(rest)) return { kind: "bin", name: rest };
    if (head === "checkout" && CHECKOUTS.has(rest)) return { kind: "checkout", name: rest as SiblingCheckout };
    throw new TypeError(`'${requirement}' is not a live requirement; the forms are input:<image|pdf|audio|video>, reasoning, output-budget, env:<NAME>, url:<http(s) URL>, bin:<name> and checkout:<client>`);
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

// Whether an executable of that name sits on PATH.
export const onPath = (name: string, path: string = process.env.PATH ?? ""): boolean =>
    path.split(delimiter).some((directory) => {
        if (directory.length === 0) return false;
        try { accessSync(join(directory, name), constants.X_OK); return true; } catch { return false; }
    });

// Where a sibling checkout is: its knob, else beside this repository. The path is the resolver's;
// whether anything is there is the probe's.
export const checkoutPath = (_name: SiblingCheckout, env: NodeJS.ProcessEnv = process.env): string => {
    const configured = env.PLURNK_CLIENT_CHECKOUT?.trim();
    return resolve(REPOSITORY, configured === undefined || configured.length === 0 ? "../plurnk" : configured);
};

export const checkoutKnob = (_name: SiblingCheckout): string => "PLURNK_CLIENT_CHECKOUT";

export const HOST_PROBES: HostProbes = { url: reachable, bin: onPath, checkout: checkoutPath };

export const needsRoute = (requirements: readonly LiveRequirement[]): boolean =>
    requirements.some((requirement) => ["input", "reasoning", "output-budget"].includes(parseRequirement(requirement).kind));

// Every unmet requirement, each as `requires <requirement>: <what was observed>`; empty when the
// specimen may run. `facts` is consulted only for the route-bound kinds.
export const unmetRequirements = async (
    requirements: readonly LiveRequirement[],
    facts: () => Promise<RouteFacts>,
    env: NodeJS.ProcessEnv = process.env,
    probes: HostProbes = HOST_PROBES,
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
                if (!(await probes.url(parsed.url))) observed = `${parsed.url} did not answer within ${PROBE_TIMEOUT_MS / 1000} s`;
                break;
            case "bin":
                if (!probes.bin(parsed.name)) observed = `${parsed.name} is not on PATH`;
                break;
            case "checkout": {
                const path = probes.checkout(parsed.name, env);
                if (!existsSync(path)) observed = `no ${parsed.name} checkout at ${path}; ${checkoutKnob(parsed.name)} names one`;
                break;
            }
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
// requirement the catalog cannot answer (an environment key, a URL, a binary, a checkout), and an
// uncataloged route never qualifies, as the provider it instantiates advertises nothing.
export const aliasesSatisfying = (
    requirement: LiveRequirement,
    aliases: readonly { readonly alias: string; readonly provider: string; readonly model: string }[],
): string[] | null => {
    const parsed = parseRequirement(requirement);
    if (parsed.kind === "env" || parsed.kind === "url" || parsed.kind === "bin" || parsed.kind === "checkout") return null;
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
