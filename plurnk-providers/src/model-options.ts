import { matchesGlob } from "node:path";
import type { AiSdkProviderOptions } from "./AiSdkProvider.ts";
import { providerSetting } from "./provider-env.ts";

type Rule = { readonly models: readonly string[]; readonly options: AiSdkProviderOptions };

const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// {§provider-model-options}: provider options a provider declares for the models its globs match; the first rule
// whose glob matches the route's model applies, and none applies when no rule matches.
export const providerModelOptions = (
    provider: string,
    env: NodeJS.ProcessEnv,
    suffix: "ADAPTIVE_OPTIONS" | "SYSTEM_CACHE_OPTIONS",
    model: string,
): AiSdkProviderOptions | undefined => {
    const [key, raw] = providerSetting(provider, env, suffix);
    if (raw === undefined || raw === "") return undefined;
    const shape = `${key} must be a JSON array of {"models":["<glob>",…],"options":{…}} rules`;
    let rules: unknown;
    try { rules = JSON.parse(raw); } catch (cause) { throw new TypeError(shape, { cause }); }
    if (!Array.isArray(rules) || !rules.every((rule): rule is Rule => object(rule)
        && Array.isArray(rule.models) && rule.models.length > 0
        && rule.models.every((glob) => typeof glob === "string" && glob !== "")
        && object(rule.options))) {
        throw new TypeError(shape);
    }
    return rules.find((rule) => rule.models.some((glob) => matchesGlob(model, glob)))?.options;
};
