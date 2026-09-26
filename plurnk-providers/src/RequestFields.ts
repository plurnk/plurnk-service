import { REASONING_POLICIES, type ReasoningPolicy } from "@plurnk/plurnk-contracts";
import type { ModelReasoningOption } from "@plurnk/plurnk-models";
import { UnsupportedReasoningPolicyError } from "./types.ts";
import { providerEnvPrefix, providerSetting } from "./provider-env.ts";
import { adaptiveEffortFromEnv } from "./reasoning-effort.ts";

type ObjectValue = Record<string, unknown>;
type Facts = { readonly reasoning: boolean; readonly reasoningOptions?: readonly ModelReasoningOption[] };
const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof efforts[number] | "none";
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const managed = new Set([
    "model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
    "temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty", "seed", "stop",
    "tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "n",
    "grammar", "response_format", "id_slot", "logprobs", "top_logprobs",
]);
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const prefixOf = (left: readonly string[], right: readonly string[]): boolean =>
    left.length <= right.length && left.every((part, index) => part === right[index]);

const pointer = (raw: string | undefined, key: string, output = false): readonly string[] | undefined => {
    if (raw === undefined || raw === "") return undefined;
    if (!raw.startsWith("/") || /~(?![01])/u.test(raw)) throw new TypeError(`${key} must be an RFC 6901 object-member pointer`);
    const path = raw.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (path.some((part) => unsafe.has(part)) || managed.has(path[0]!) && !(output && path.length === 1 && ["max_tokens", "max_completion_tokens"].includes(path[0]!))) {
        throw new TypeError(`${key} cannot address a transport-owned field`);
    }
    return path;
};

const set = (body: ObjectValue, path: readonly string[], value: unknown): void => {
    let parent = body;
    for (const part of path.slice(0, -1)) {
        const existing = parent[part];
        if (existing === undefined) parent[part] = {};
        else if (!object(existing)) throw new TypeError(`request fields overlap at ${part}`);
        parent = parent[part] as ObjectValue;
    }
    parent[path.at(-1)!] = value;
};

const leaves = (body: ObjectValue, parent: readonly string[] = []): (readonly string[])[] =>
    Object.entries(body).flatMap(([key, value]) => object(value) && Object.keys(value).length > 0
        ? leaves(value, [...parent, key])
        : [[...parent, key]]);

const merge = (left: ObjectValue, right: ObjectValue): ObjectValue => {
    const result = structuredClone(left);
    for (const path of leaves(right)) {
        const value = path.reduce<unknown>((at, key) => (at as ObjectValue)[key], right);
        set(result, path, structuredClone(value));
    }
    return result;
};

// {§provider-wire-declaration} Only the declared coordinates vary. The catalog owns
// capabilities; this projection never consults a provider or model spelling.
export default class RequestFields {
    static isManaged(name: string): boolean { return managed.has(name) || unsafe.has(name); }

    static readonly knobs = Object.freeze([
        "OUTPUT_PATH", "REASONING_EFFORT_PATH", "REASONING_BUDGET_PATH", "REASONING_EFFORTS",
        "REASONING_CONTROLS", "REASONING_ON_BODY", "REASONING_OFF_BODY", "REASONING_ADAPTIVE_BODY", "REASONING_TOGGLE_BODY",
        "OPTIONS_NAMESPACE", "REASONING_TRANSPORT_EFFORTS",
    ].map((suffix) => `PLURNK_PROVIDERS_${suffix}`));

    static rejectRetired(env: NodeJS.ProcessEnv, keys: readonly string[]): void {
        const key = keys.find((key) => env[key] !== undefined && env[key] !== "");
        if (key !== undefined) throw new TypeError(`${key} is retired; use request-field declarations ({§provider-wire-declaration})`);
    }

    static #assertCurrent(name: string, env: NodeJS.ProcessEnv): void {
        const prefix = providerEnvPrefix(name);
        RequestFields.rejectRetired(env, ["PLURNK_PROVIDERS_REASONING_STYLE", `PLURNK_PROVIDERS_PROVIDER_${prefix}_REASONING_STYLE`]);
    }

    static namespace(name: string, env: NodeJS.ProcessEnv): string | undefined {
        const [key, value] = providerSetting(name, env, "OPTIONS_NAMESPACE");
        if (value === undefined || value === "") return undefined;
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(value) || unsafe.has(value)) throw new TypeError(`${key} must name one SDK provider-options namespace`);
        return value;
    }

    static #effortValues(name: string, env: NodeJS.ProcessEnv, suffix: string): readonly Effort[] | undefined {
        const [key, raw] = providerSetting(name, env, suffix);
        if (raw === undefined) return undefined;
        const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
        const invalid = values.find((value) => value !== "none" && !efforts.includes(value as typeof efforts[number]));
        if (invalid !== undefined) throw new TypeError(`${key} has invalid value "${invalid}"; declarable efforts: none, ${efforts.join(", ")}`);
        return [...new Set(values as Effort[])];
    }

    static declaredEfforts(name: string, env: NodeJS.ProcessEnv): readonly Effort[] {
        return RequestFields.#effortValues(name, env, "REASONING_EFFORTS") ?? [];
    }

    static assertNative(name: string, env: NodeJS.ProcessEnv): void {
        RequestFields.#assertCurrent(name, env);
        for (const key of RequestFields.knobs) {
            if (key === "PLURNK_PROVIDERS_REASONING_EFFORTS") continue;
            const [configured, value] = providerSetting(name, env, key.slice("PLURNK_PROVIDERS_".length));
            if (value !== undefined && value !== "") {
                throw new TypeError(`${name} provider: ${configured} configures compatible request fields, not this native SDK`);
            }
        }
    }

    readonly policies: readonly [ReasoningPolicy, ...ReasoningPolicy[]];
    readonly namespace: string | undefined;
    readonly managedKeys: ReadonlySet<string>;
    readonly #name: string;
    readonly #output: readonly string[];
    readonly #effort: readonly string[] | undefined;
    readonly #budget: readonly string[] | undefined;
    readonly #on: ObjectValue;
    readonly #off: ObjectValue | undefined;
    readonly #adaptive: ObjectValue | undefined;
    readonly #toggle: ObjectValue | undefined;
    readonly #combined: boolean;
    readonly #efforts: readonly string[];
    readonly #adaptiveEffort: string | undefined;
    readonly #facts: Facts | undefined;

    constructor(name: string, env: NodeJS.ProcessEnv, facts?: Facts) {
        RequestFields.#assertCurrent(name, env);
        this.#name = name;
        this.#facts = facts;
        const read = (suffix: string) => providerSetting(name, env, suffix);
        this.namespace = RequestFields.namespace(name, env);
        if (this.namespace !== undefined && read("OUTPUT_PATH")[1]) throw new TypeError(`${name} provider: OUTPUT_PATH belongs to the compatible transport; native SDKs own their output field`);
        const readPath = (suffix: string, output = false) => {
            const [key, raw] = read(suffix);
            return pointer(raw, key, output);
        };
        // The compatible SDK's standard output field, not a vendor default.
        this.#output = readPath("OUTPUT_PATH", true) ?? ["max_tokens"];
        this.#effort = readPath("REASONING_EFFORT_PATH");
        this.#budget = readPath("REASONING_BUDGET_PATH");
        const paths = [this.#output, this.#effort, this.#budget].filter((path) => path !== undefined);
        for (const [index, left] of paths.entries()) {
            if (paths.slice(index + 1).some((right) => prefixOf(left, right) || prefixOf(right, left))) {
                throw new TypeError(`${name} provider: OUTPUT_PATH, REASONING_EFFORT_PATH, and REASONING_BUDGET_PATH must not overlap`);
            }
        }
        const readBody = (suffix: string): ObjectValue | undefined => {
            const [key, raw] = read(suffix);
            if (raw === undefined || raw === "") return undefined;
            let body: unknown;
            try { body = JSON.parse(raw); } catch (cause) { throw new TypeError(`${key} must be a JSON object`, { cause }); }
            if (!object(body)) throw new TypeError(`${key} must be a JSON object`);
            for (const path of leaves(body)) {
                if (path.some((part) => unsafe.has(part)) || managed.has(path[0]!)) throw new TypeError(`${key} cannot override a transport-owned field`);
                if (paths.some((dynamic) => (dynamic !== this.#effort || suffix === "REASONING_ON_BODY") && (prefixOf(path, dynamic) || prefixOf(dynamic, path)))) {
                    throw new TypeError(`${key} and dynamic request fields overlap`);
                }
            }
            return body;
        };
        this.#on = readBody("REASONING_ON_BODY") ?? {};
        this.#off = readBody("REASONING_OFF_BODY");
        this.#adaptive = readBody("REASONING_ADAPTIVE_BODY");
        this.#toggle = readBody("REASONING_TOGGLE_BODY");
        this.managedKeys = new Set([
            ...paths.map((path) => path[0]!),
            ...[this.#on, this.#off, this.#adaptive, this.#toggle].flatMap((body) => Object.keys(body ?? {})),
        ]);
        const [controlKey, controls] = read("REASONING_CONTROLS");
        if (controls !== undefined && controls !== "" && controls !== "exclusive" && controls !== "combined") {
            throw new TypeError(`${controlKey} must be exclusive or combined`);
        }
        if (this.#effort !== undefined && this.#budget !== undefined && (controls === undefined || controls === "")) {
            throw new TypeError(`${controlKey} must declare whether effort and budget are exclusive or combined`);
        }
        this.#combined = controls === "combined";
        const declared = RequestFields.declaredEfforts(name, env);
        const transport = RequestFields.#effortValues(name, env, "REASONING_TRANSPORT_EFFORTS");
        this.#efforts = [...new Set([
            ...(facts?.reasoningOptions?.flatMap((option) => option.type === "effort" ? option.values.flatMap((value) => value === null ? [] : [value]) : []) ?? []),
            ...declared,
        ])].filter((effort) => transport === undefined || transport.some((value) => value === effort));
        this.#adaptiveEffort = adaptiveEffortFromEnv(env, this.#efforts);
        const policies = facts?.reasoning === false
            ? ["off", "adaptive"] as const
            : REASONING_POLICIES.filter((policy) => policy === "adaptive"
                || policy === "off" && (
                    this.#off !== undefined && (facts === undefined || facts.reasoningOptions?.some((option) => option.type === "toggle") || this.#efforts.includes("none"))
                    || this.#effort !== undefined && this.#efforts.includes("none")
                )
                || this.#effort !== undefined && this.#efforts.includes(policy));
        const [first, ...rest] = policies;
        if (first === undefined) throw new TypeError(`${name} provider: no reasoning policy is representable`);
        this.policies = [first, ...rest];
    }

    body(mode: ReasoningPolicy, output: number | null, budget: number | null): ObjectValue {
        if (!this.policies.includes(mode)) throw new UnsupportedReasoningPolicyError(`provider:${this.#name}`, mode, this.policies);
        if (this.#facts?.reasoning === false && budget !== null) throw new TypeError(`${this.#name} model does not support reasoning`);
        const active = mode !== "off" && this.#facts?.reasoning !== false;
        let body: ObjectValue = active ? structuredClone(this.#on) : {};
        if (this.#facts?.reasoning !== false) {
            if (!active) {
                body = this.#off === undefined ? {} : structuredClone(this.#off);
                if (this.#off === undefined && this.#effort !== undefined && this.#efforts.includes("none")) set(body, this.#effort, "none");
            } else if (budget !== null) {
                if (this.#budget === undefined) throw new TypeError(`${this.#name} provider: reasoning budget has no REASONING_BUDGET_PATH`);
                if (mode !== "adaptive" && !this.#combined) throw new TypeError(`${this.#name} provider: reasoning effort and budget are exclusive; choose one control`);
                for (const option of this.#facts?.reasoningOptions ?? []) {
                    if (option.type !== "budget_tokens") continue;
                    if (option.min !== undefined && budget < option.min) throw new TypeError(`${this.#name} provider: reasoning budget ${budget} is below catalog minimum ${option.min}`);
                    if (option.max !== undefined && budget > option.max) throw new TypeError(`${this.#name} provider: reasoning budget ${budget} exceeds catalog maximum ${option.max}`);
                }
                set(body, this.#budget, budget);
                if (mode !== "adaptive") set(body, this.#effort!, mode);
            } else if (mode !== "adaptive") {
                set(body, this.#effort!, mode);
            } else if (this.#adaptive !== undefined) {
                body = merge(body, this.#adaptive);
            } else if (this.#effort !== undefined && this.#adaptiveEffort !== undefined) {
                set(body, this.#effort, this.#adaptiveEffort);
            } else if (this.#toggle !== undefined && this.#facts?.reasoningOptions?.some((option) => option.type === "toggle")) {
                body = merge(body, this.#toggle);
            }
        }
        if (output !== null && this.namespace === undefined) set(body, this.#output, output);
        return body;
    }
}
