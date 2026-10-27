import { isRecord } from "@plurnk/plurnk-contracts";
import { outboundFetch } from "@plurnk/plurnk-meta";
import { contextWindowFromEnv, effectiveContextWindow, parseTimeoutMs, requireEnv } from "./env.ts";
import { providerFromModelAdapter } from "./catalogProvider.ts";
import type { Provider, ProviderModel, ProviderOptions } from "./types.ts";

const fetchContextWindow = async ({
    baseUrl,
    model,
    timeout,
}: {
    baseUrl: string;
    model: string;
    timeout: number;
}): Promise<number> => {
    const response = await outboundFetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    if (!response.ok) throw new Error(`ollama provider: /api/show returned ${response.status}`);
    const data: unknown = await response.json();
    const info = isRecord(data) && isRecord(data.model_info) ? data.model_info : {};
    for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
    }
    throw new Error(`ollama provider: /api/show has no *.context_length key for "${model}"`);
};

export const ollamaProviderFromEnv = async (
    env: NodeJS.ProcessEnv,
    model: string,
    options?: ProviderOptions,
): Promise<Provider> => {
    const configured = options?.baseUrl ?? env.OLLAMA_BASE_URL ?? env.OLLAMA_HOST;
    const baseUrl = requireEnv(
        configured,
        "OLLAMA_BASE_URL or OLLAMA_HOST (or a PLURNK_BASEURL_<alias> override)",
        "ollama",
    ).replace(/\/+$/, "").replace(/\/v1$/, "");
    const timeout = parseTimeoutMs(
        env.PLURNK_PROVIDERS_FETCH_TIMEOUT,
        "PLURNK_PROVIDERS_FETCH_TIMEOUT",
        "ollama",
    );
    // {§model-fact-resolution}
    const contextWindow = effectiveContextWindow(
        contextWindowFromEnv(env, "ollama"),
        await fetchContextWindow({ baseUrl, model, timeout }),
    );
    const providerModel: ProviderModel = {
        id: model,
        name: model,
        api: "openai-completions",
        provider: "ollama",
        namespace: "ollama",
        baseUrl: `${baseUrl}/v1`,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 16_384,
        apiKey: "ollama",
        includeTopK: true,
        compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
            supportsReasoningEffort: false,
            supportsFinishReason: true,
        },
    };
    return providerFromModelAdapter({
        name: "ollama",
        env,
        model,
        providerModel,
        endpoint: `${baseUrl}/v1`,
        contextWindow,
    });
};
