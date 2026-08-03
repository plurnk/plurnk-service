import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { contextWindowFromEnv, effectiveContextWindow, parseRequiredInt, requireEnv } from "./env.ts";
import { providerFromSdkModel } from "./catalogProvider.ts";
import type { Provider, ProviderOptions } from "./types.ts";

type ShowResponse = {
    model_info?: Record<string, unknown>;
};

const fetchContextWindow = async ({
    baseUrl,
    model,
    timeout,
}: {
    baseUrl: string;
    model: string;
    timeout: number;
}): Promise<number> => {
    const response = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`ollama provider: /api/show returned ${response.status}`);
    const data = await response.json() as ShowResponse;
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
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
    const timeout = parseRequiredInt(
        env.PLURNK_PROVIDERS_FETCH_TIMEOUT,
        "PLURNK_PROVIDERS_FETCH_TIMEOUT",
        "ollama",
    );
    // {§model-fact-resolution}
    const contextWindow = effectiveContextWindow(
        contextWindowFromEnv(env, "ollama"),
        await fetchContextWindow({ baseUrl, model, timeout }),
    );
    const languageModel = createOpenAICompatible({
        name: "ollama",
        baseURL: `${baseUrl}/v1`,
        includeUsage: true,
    }).languageModel(model);
    return providerFromSdkModel({
        name: "ollama",
        env,
        model,
        languageModel,
        contextWindow,
    });
};
