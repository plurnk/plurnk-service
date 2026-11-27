import { isProviderCredentialName, lookupProvider, providerCatalogSnapshot, resolveModel, type ProviderInfo } from "@plurnk/plurnk-models";
import type { ProviderSpec } from "@plurnk/plurnk-aliases";
import { Validator, type ModelReadiness, type ModelReadinessCause } from "@plurnk/plurnk-contracts";
import { providerCostNormalizer } from "./accounting.ts";
import { scopeEnvToAlias } from "./env.ts";
import { providerSetting, providerEnvPrefix as envPrefix } from "./provider-env.ts";
import type {
    CacheAffinity,
    NativeRequestControls,
    PromptCacheStyle,
} from "./ModelProvider.ts";
import type { ProviderModel, ProviderCostNormalizer } from "./types.ts";

export type ProviderModelAdapter = {
    readonly endpoint?: string;
    readonly providerModel?: ProviderModel;
    readonly normalizeCost?: ProviderCostNormalizer;
    readonly compatible?: {
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
    };
    readonly cacheAffinity?: CacheAffinity;
    readonly promptCacheBreakpoints?: PromptCacheStyle;
    readonly additiveReasoningProvider?: "anthropic" | "bedrock";
    // {§provider-request-authority} — the global controls this adapter documents.
    readonly requestControls?: NativeRequestControls;
    readonly catalog: ProviderInfo | null;
};

// The release generator admits only adapters implemented by this package, plus the
// built-in `llama-server` local/self-hosted declaration adapter (#1596).
const supportedAdapters = new Set<string>([
    ...Object.values(providerCatalogSnapshot()).map(({ adapter }) => adapter),
    "llama-server",
]);

export const isCompatibleAdapter = (adapter: string): boolean =>
    adapter === "openai-compatible" || adapter === "llama-server";

// {§provider-request-authority}: an OpenRouter route's application attribution is its provider's declaration,
// handed to the adapter, which owns the headers.
const openRouterAttributionHeaders = (provider: string, env: NodeJS.ProcessEnv): Record<string, string> => {
    const [urlKey, rawUrl] = providerSetting(provider, env, "APP_URL");
    const url = rawUrl?.trim();
    if (url === undefined || url === "") return {};
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (cause) {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`, { cause });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`${provider} provider: ${urlKey} must be an absolute HTTP(S) URL.`);
    }
    const name = providerSetting(provider, env, "APP_NAME")[1]?.trim();
    return {
        "HTTP-Referer": parsed.href,
        ...(name === undefined || name === "" ? {} : { "X-OpenRouter-Title": name }),
    };
};

// {§model-fact-resolution} — one credential declaration holds exactly one
// name. An ordered fallback list would paper over an operator/catalog naming
// mismatch; that mismatch belongs at its owning boundary instead.
const singleCredentialName = (provider: string, value: string): string => {
    const name = value.trim();
    if (name.length === 0) throw new Error(`${provider} provider: API_KEY_ENV must name one environment variable.`);
    if (name.includes(",")) {
        throw new Error(
            `${provider} provider: API_KEY_ENV holds one exact name, never an ordered fallback; reconcile the operator environment with the Models.dev contract instead.`,
        );
    }
    return name;
};

export const configuredProviderInfo = (
    provider: string,
    env: NodeJS.ProcessEnv,
): ProviderInfo | null => {
    const prefix = `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}`;
    const adapter = env[`${prefix}_ADAPTER`];
    if (adapter === undefined || adapter.length === 0) return null;
    const declared = env[`${prefix}_API_KEY_ENV`];
    const keyNames = declared === undefined
        ? []
        : [singleCredentialName(provider, declared)];
    const api = env[`${prefix}_BASE_URL`];
    return {
        id: provider,
        name: provider,
        adapter,
        env: keyNames,
        ...(api === undefined || api.length === 0 ? {} : { api }),
    };
};

const firstSet = (env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined => {
    for (const name of names) {
        const value = env[name];
        if (value !== undefined && value.length > 0) return value;
    }
    return undefined;
};

const isSet = (env: NodeJS.ProcessEnv, name: string): boolean => {
    const value = env[name];
    return value !== undefined && value.length > 0;
};

const configuredKeyNames = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`];
    return configured === undefined || configured.length === 0
        ? catalog.env
        : [singleCredentialName(provider, configured)];
};

const credentialCandidates = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): readonly string[] => {
    const names = configuredKeyNames(provider, env, catalog);
    const credentials = names.filter(isProviderCredentialName);
    return credentials.length > 0 ? credentials : names;
};

const configuredBaseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    const prefix = envPrefix(provider);
    return override
        ?? env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`]
        ?? env[`${prefix}_BASE_URL`]
        ?? catalog.api;
};

const templateEnvironmentNames = (value: string | undefined): readonly string[] => value === undefined
    ? []
    : [...new Set([...value.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]))];

// A list the readiness contract requires to name at least one item: built, never claimed.
const nonEmpty = <T>(items: readonly T[], subject: string): [T, ...T[]] => {
    if (items.length === 0) throw new TypeError(`A model readiness cause names no ${subject}.`);
    const [first, ...rest] = items;
    return [first, ...rest];
};

const missingCause = (
    kind: ModelReadinessCause["kind"],
    alternatives: readonly (readonly string[])[],
): ModelReadinessCause => ({
    kind,
    alternatives: nonEmpty(alternatives.map((alternative) => nonEmpty(alternative, "variable in an alternative")), "alternative"),
});

const bedrockReadinessCauses = (
    env: NodeJS.ProcessEnv,
    hasExplicitBaseUrl: boolean,
): ModelReadinessCause[] => {
    const bearer = isSet(env, "AWS_BEARER_TOKEN_BEDROCK");
    const sigv4 = isSet(env, "AWS_ACCESS_KEY_ID") && isSet(env, "AWS_SECRET_ACCESS_KEY");
    const region = isSet(env, "AWS_REGION") || isSet(env, "AWS_DEFAULT_REGION");
    if (bearer) {
        return hasExplicitBaseUrl || region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    if (sigv4) {
        return region
            ? []
            : [missingCause("configuration", [["AWS_REGION"], ["AWS_DEFAULT_REGION"]])];
    }
    return [missingCause("credential", hasExplicitBaseUrl
        ? [
            ["AWS_BEARER_TOKEN_BEDROCK"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ]
        : [
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"],
            ["AWS_BEARER_TOKEN_BEDROCK", "AWS_DEFAULT_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"],
        ])];
};

export const providerCredentialSpecs = (
    provider: string,
    env: NodeJS.ProcessEnv = process.env,
): { readonly credentialKeys: readonly string[]; readonly baseUrlKey: string } | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null || !supportedAdapters.has(catalog.adapter)) return null;
    const prefix = envPrefix(provider);
    const baseUrlKey = provider === "openai" && env.PLURNK_PROVIDERS_PROVIDER_OPENAI_BASE_URL === undefined
        ? "OPENAI_BASE_URL"
        : `PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`;
    if (catalog.adapter === "amazon-bedrock") {
        return {
            credentialKeys: ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
            baseUrlKey,
        };
    }
    const candidates = credentialCandidates(provider, env, catalog);
    return {
        credentialKeys: [...new Set(candidates)],
        baseUrlKey,
    };
};

// Local evidence only: this shares the exact environment and endpoint rules
// used by createProviderModel, but never probes a provider or validates a secret.
export const providerReadiness = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ModelReadiness | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedAdapters.has(catalog.adapter)) return null;
    const rawUrl = configuredBaseUrl(provider, env, catalog, baseUrlOverride);
    const missingCoordinates = templateEnvironmentNames(rawUrl).filter((name) => !isSet(env, name));
    const causes: ModelReadinessCause[] = missingCoordinates.length === 0
        ? []
        : [missingCause("configuration", [missingCoordinates])];

    if (catalog.adapter === "amazon-bedrock") {
        causes.push(...bedrockReadinessCauses(env, rawUrl !== undefined));
    } else {
        const candidates = credentialCandidates(provider, env, catalog);
        const credentialRequired = !isCompatibleAdapter(catalog.adapter) || candidates.length > 0;
        if (credentialRequired && candidates.length === 0) {
            causes.push(missingCause("configuration", [[
                `PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`,
            ]]));
        } else if (credentialRequired && firstSet(env, candidates) === undefined) {
            causes.push(missingCause("credential", candidates.map((name) => [name])));
        }
        if (isCompatibleAdapter(catalog.adapter) && rawUrl === undefined) {
            const prefix = envPrefix(provider);
            causes.push(missingCause("configuration", [
                [`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`],
                [`${prefix}_BASE_URL`],
            ]));
        }
    }
    return Validator.assertModelReadiness({ ready: causes.length === 0, causes });
};

export const formatModelReadinessCauses = (readiness: ModelReadiness): string =>
    readiness.causes
        .map(({ alternatives }) => alternatives.map((group) => group.join(" and ")).join(" or "))
        .join("; ");

export const routeReadiness = (
    route: ProviderSpec,
    env: NodeJS.ProcessEnv = process.env,
): ModelReadiness | null => {
    if ((route.provider === "openai" || route.provider === "ollama") && resolveModel(route.provider, route.model) === null) {
        return null;
    }
    const scoped = route.alias === undefined ? env : scopeEnvToAlias(env, route.alias);
    return providerReadiness(route.provider, scoped, route.baseUrl);
};

const assertProviderReady = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): void => {
    const readiness = providerReadiness(provider, env, baseUrlOverride);
    if (readiness === null || readiness.ready) return;
    throw new Error(`${provider} provider: ${formatModelReadinessCauses(readiness)} must be set`);
};

const expandEnv = (value: string, env: NodeJS.ProcessEnv, provider: string): string =>
    value.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
        const replacement = env[name];
        if (replacement === undefined || replacement.length === 0) {
            throw new Error(`${provider} provider: ${name} must be set to resolve the Models.dev API URL`);
        }
        return replacement;
    });

const baseUrl = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    override?: string,
): string | undefined => {
    // {§model-fact-resolution} — distinct sources, one precedence: the PLURNK
    // knob, then the provider-native convention (OPENAI_BASE_URL etc.), then
    // the catalog. This is not an alias fallback: each source is a different
    // owner, and the catalog remains the last authority.
    const value = configuredBaseUrl(provider, env, catalog, override);
    return value === undefined ? undefined : expandEnv(value, env, provider).replace(/\/+$/, "");
};

const requireApiKey = (
    provider: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
): string => {
    // {§model-fact-resolution} — a catalog `env` list mixes credentials with
    // non-secret coordinates; the credential is the credential-named one.
    const candidates = credentialCandidates(provider, env, catalog);
    const key = firstSet(env, candidates);
    if (key === undefined) throw new Error(`${provider} provider: ${candidates.join(" or ")} must be set`);
    return key;
};

const normalizeCompatibleChatUrl = (raw: string): string => {
    const base = raw.replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    try {
        const parsed = new URL(base);
        if (parsed.pathname === "" || parsed.pathname === "/") {
            return `${base}/v1/chat/completions`;
        }
    } catch {
        return `${base.replace(/\/v1$/, "")}/v1/chat/completions`;
    }
    return `${base}/chat/completions`;
};

export const resolveCompatibleEndpoint = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly adapter?: string;
} => {
    if (provider === "openai" && configuredProviderInfo("openai", env) === null) {
        const rawUrl =
            baseUrlOverride
            ?? env.PLURNK_PROVIDERS_PROVIDER_OPENAI_BASE_URL
            ?? env.OPENAI_BASE_URL
            ?? env.OPENAI_API_BASE;
        if (rawUrl === undefined || rawUrl.length === 0) {
            throw new Error("openai provider: OPENAI_BASE_URL or OPENAI_API_BASE must be set");
        }
        const expanded = expandEnv(rawUrl, env, "openai");
        const declaredKeyEnv = env.PLURNK_PROVIDERS_PROVIDER_OPENAI_API_KEY_ENV;
        let apiKey: string | undefined;
        if (declaredKeyEnv !== undefined && declaredKeyEnv.length > 0) {
            const keyName = singleCredentialName("openai", declaredKeyEnv);
            apiKey = env[keyName];
            if (apiKey === undefined || apiKey.length === 0) {
                throw new Error(`openai provider: ${keyName} must be set`);
            }
        } else {
            apiKey = env.OPENAI_API_KEY;
        }
        return {
            url: normalizeCompatibleChatUrl(expanded),
            headers: apiKey === undefined || apiKey.length === 0 ? {} : { Authorization: `Bearer ${apiKey}` },
        };
    }

    const resolved = resolveAdapterProvider(provider, env, baseUrlOverride);
    if (resolved === null || resolved.url === undefined) {
        const prefix = envPrefix(provider);
        throw new Error(
            `${provider} provider: PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL or ${prefix}_BASE_URL must be set`,
        );
    }
    const keyNames = configuredKeyNames(provider, env, resolved.catalog);
    const apiKey = keyNames.length === 0 ? undefined : requireApiKey(provider, env, resolved.catalog);
    return {
        url: normalizeCompatibleChatUrl(resolved.url),
        headers: apiKey === undefined || apiKey.length === 0 ? {} : { Authorization: `Bearer ${apiKey}` },
        adapter: resolved.catalog.adapter,
    };
};

const resolveAdapterProvider = (
    provider: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): { catalog: ProviderInfo; url: string | undefined } | null => {
    const catalog = lookupProvider(provider) ?? configuredProviderInfo(provider, env);
    if (catalog === null) return null;
    if (!supportedAdapters.has(catalog.adapter)) {
        throw new Error(`${provider} provider: unsupported provider adapter ${catalog.adapter}`);
    }
    assertProviderReady(provider, env, baseUrlOverride);
    return { catalog, url: baseUrl(provider, env, catalog, baseUrlOverride) };
};

const providerCacheAffinity = (provider: string): CacheAffinity | undefined => {
    switch (provider) {
        case "openai":
        case "deepinfra":
        case "xai":
        case "moonshotai":
        case "moonshotai-cn":
        case "kimi-code-plan-global":
        case "kimi-code-plan-cn":
            return { target: "body", name: "prompt_cache_key" };
        case "openrouter":
            return { target: "header", name: "x-session-id" };
        case "cloudflare-workers-ai":
        case "fireworks-ai":
            return { target: "header", name: "x-session-affinity" };
        default:
            return undefined;
    }
};

const bedrockClaudePromptCaching = (model: string): boolean => {
    const normalized = model.toLowerCase().replaceAll(/[\s_.:]+/gu, "-");
    if (!normalized.includes("claude")) return false;
    return normalized.includes("claude-3-5-haiku")
        || normalized.includes("claude-3-7-sonnet")
        || normalized.includes("sonnet-4")
        || normalized.includes("opus-4")
        || normalized.includes("haiku-4")
        || normalized.includes("fable-5")
        || normalized.includes("opus-5")
        || normalized.includes("sonnet-5")
        || normalized.includes("haiku-5");
};

const minimaxAnthropicPromptCaching = (provider: string): boolean =>
    provider === "minimax"
    || provider === "minimax-cn"
    || provider === "minimax-coding-plan"
    || provider === "minimax-cn-coding-plan";

const openAIExplicitPromptCaching = (provider: string, model: string): boolean => {
    let bareModel: string | undefined;
    if (provider === "openai") {
        bareModel = model;
    } else if (provider === "openrouter") {
        if (model.startsWith("openai/")) bareModel = model.slice("openai/".length);
        else if (model.startsWith("~openai/")) bareModel = model.slice("~openai/".length);
    }
    if (bareModel === undefined) return false;
    const normalized = bareModel.toLowerCase();
    if (normalized.includes("-decisions")
        || normalized.includes("-realtime")
        || normalized.includes("-audio")
        || normalized.includes("-image")) {
        return false;
    }
    if ((resolveModel(provider, model)?.info.cost?.cacheWritePer1M ?? 0) > 0) return true;
    if (normalized.startsWith("gpt-daybreak-")) return true;
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:$|-)/u.exec(normalized);
    if (match === null) return false;
    const major = Number(match[1]);
    const minor = match[2] === undefined ? 0 : Number(match[2]);
    return major > 5 || (major === 5 && minor >= 6);
};

const providerPromptCacheBreakpoints = (provider: string, model: string): PromptCacheStyle | undefined => {
    if (provider === "anthropic"
        || minimaxAnthropicPromptCaching(provider)
        || provider === "openrouter" && (model.startsWith("anthropic/") || model.startsWith("~anthropic/"))
        || provider === "amazon-bedrock" && bedrockClaudePromptCaching(model)) {
        return "ephemeral";
    }
    if (openAIExplicitPromptCaching(provider, model)) {
        return "openai-explicit";
    }
    return undefined;
};

export const createProviderModel = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    baseUrlOverride?: string,
): ProviderModelAdapter | null => {
    const resolved = resolveAdapterProvider(provider, env, baseUrlOverride);
    if (resolved === null) return null;
    const { catalog, url } = resolved;
    const cacheAffinity = providerCacheAffinity(provider);
    const promptCacheBreakpoints = providerPromptCacheBreakpoints(provider, model);
    return {
        ...modelFromAdapter(provider, model, { ...env }, catalog, url),
        ...(promptCacheBreakpoints === undefined ? {} : { promptCacheBreakpoints }),
        ...(cacheAffinity === undefined ? {} : { cacheAffinity }),
        endpoint: url,
    };
};

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const openAICompletionsModel = (
    id: string,
    options: {
        provider: string;
        baseUrl: string;
        apiKey?: string;
        headers?: Readonly<Record<string, string>>;
        includeTopK?: boolean;
        maxTokensField?: "max_tokens" | "max_completion_tokens";
    },
): ProviderModel => ({
    id,
    name: id,
    api: "openai-completions",
    provider: options.provider,
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    reasoning: true,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.includeTopK === undefined ? {} : { includeTopK: options.includeTopK }),
    compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: options.maxTokensField ?? "max_tokens",
        supportsReasoningEffort: true,
        supportsUsageInStreaming: options.provider !== "mistral",
        supportsFinishReason: true,
        thinkingFormat: "openai",
    },
});

const OPENAI_COMPLETIONS_ADAPTERS: Readonly<Record<string, {
    readonly defaultBaseUrl: string;
    readonly serviceTier: boolean;
    readonly logprobs: boolean;
    readonly includeTopK?: boolean;
}>> = {
    openai: { defaultBaseUrl: "https://api.openai.com/v1", serviceTier: true, logprobs: true },
    groq: { defaultBaseUrl: "https://api.groq.com/openai/v1", serviceTier: true, logprobs: false },
    cerebras: { defaultBaseUrl: "https://api.cerebras.ai/v1", serviceTier: true, logprobs: false },
    mistral: { defaultBaseUrl: "https://api.mistral.ai/v1", serviceTier: false, logprobs: false },
    togetherai: { defaultBaseUrl: "https://api.together.xyz/v1", serviceTier: false, logprobs: false },
    deepinfra: { defaultBaseUrl: "https://api.deepinfra.com/v1/openai", serviceTier: false, logprobs: false },
    openrouter: { defaultBaseUrl: "https://openrouter.ai/api/v1", serviceTier: false, logprobs: false, includeTopK: true },
};

const modelFromAdapter = (
    provider: string,
    model: string,
    env: NodeJS.ProcessEnv,
    catalog: ProviderInfo,
    url: string | undefined,
): ProviderModelAdapter => {
    const normalizeCost = providerCostNormalizer(catalog.adapter);
    const attributionHeaders = catalog.adapter === "openrouter"
        ? openRouterAttributionHeaders(provider, env)
        : undefined;
    const completionsSpec = OPENAI_COMPLETIONS_ADAPTERS[catalog.adapter];
    if (completionsSpec !== undefined) {
        return {
            providerModel: openAICompletionsModel(model, {
                provider: catalog.adapter,
                baseUrl: url ?? completionsSpec.defaultBaseUrl,
                apiKey: requireApiKey(provider, env, catalog),
                ...(attributionHeaders && Object.keys(attributionHeaders).length > 0 ? { headers: attributionHeaders } : {}),
                includeTopK: completionsSpec.includeTopK ?? false,
                maxTokensField: "max_tokens",
            }),
            ...(normalizeCost === undefined ? {} : { normalizeCost }),
            requestControls: {
                namespace: catalog.adapter,
                serviceTier: completionsSpec.serviceTier,
                logprobs: completionsSpec.logprobs,
            },
            catalog,
        };
    }

    switch (catalog.adapter) {
        case "xai":
            return {
                providerModel: {
                    id: model,
                    name: model,
                    api: "openai-responses",
                    provider: "xai",
                    baseUrl: (url ?? "https://api.x.ai/v1").replace(/\/+$/, ""),
                    reasoning: true,
                    input: ["text", "image"],
                    cost: ZERO_COST,
                    contextWindow: 128_000,
                    maxTokens: 16_384,
                    apiKey: requireApiKey(provider, env, catalog),
                    includeTopK: false,
                    xaiPreferResponses: true,
                },
                requestControls: { namespace: "xai", serviceTier: true, logprobs: false },
                catalog,
            };
        case "google":
            return {
                providerModel: {
                    id: model,
                    name: model,
                    api: "google-generative-ai",
                    provider: "google",
                    baseUrl: (url ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),
                    reasoning: true,
                    input: ["text", "image"],
                    cost: ZERO_COST,
                    contextWindow: 128_000,
                    maxTokens: 16_384,
                    apiKey: requireApiKey(provider, env, catalog),
                },
                requestControls: { namespace: "google", serviceTier: true, logprobs: false },
                catalog,
            };
        case "anthropic":
            return {
                providerModel: {
                    id: model,
                    name: model,
                    api: "anthropic-messages",
                    provider: "anthropic",
                    baseUrl: (url ?? "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, ""),
                    reasoning: true,
                    input: ["text", "image"],
                    cost: ZERO_COST,
                    contextWindow: 200_000,
                    maxTokens: 16_384,
                    apiKey: requireApiKey(provider, env, catalog),
                },
                additiveReasoningProvider: "anthropic",
                requestControls: { namespace: "anthropic", serviceTier: true, logprobs: false },
                catalog,
            };
        case "amazon-bedrock": {
            const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
            return {
                providerModel: {
                    id: model,
                    name: model,
                    api: "bedrock-converse-stream",
                    provider: "amazon-bedrock",
                    baseUrl: (url ?? `https://bedrock-runtime.${region}.amazonaws.com`).replace(/\/+$/, ""),
                    reasoning: true,
                    input: ["text", "image"],
                    cost: ZERO_COST,
                    contextWindow: 200_000,
                    maxTokens: 16_384,
                    ...(env.AWS_BEARER_TOKEN_BEDROCK ? { apiKey: env.AWS_BEARER_TOKEN_BEDROCK } : {}),
                    env: { ...env },
                },
                ...(model.includes("anthropic")
                    ? { additiveReasoningProvider: "bedrock" as const }
                    : {}),
                requestControls: { namespace: "bedrock", serviceTier: true, logprobs: false },
                catalog,
            };
        }
        case "llama-server":
        case "openai-compatible": {
            if (url === undefined) throw new Error(`${provider} provider: Models.dev supplies no API URL and no base URL was configured`);
            const keyNames = configuredKeyNames(provider, env, catalog);
            const key = keyNames.length === 0 ? undefined : requireApiKey(provider, env, catalog);
            return {
                compatible: {
                    url: `${url}/chat/completions`,
                    headers: key === undefined
                        ? {}
                        : { Authorization: `Bearer ${key}` },
                },
                catalog,
            };
        }
        default:
            throw new Error(`${provider} provider: unsupported provider adapter ${catalog.adapter}`);
    }
};
