// GenAI semantic-convention projection ({§observability-genai-conventions}).
// The provider request span uses the OpenTelemetry GenAI conventions so
// standard vendor dashboards compose with Plurnk traces; custom
// attributes ride alongside and never replace the convention attributes.
import { SpanKind, type Span } from "@opentelemetry/api";
import type { ProviderResponse } from "@plurnk/plurnk-providers";
import { aggregateProviderAccounting } from "@plurnk/plurnk-providers/accounting";

export const genAiRequestName = (model: string): string => `chat ${model}`;

// Registry spellings differ from the models.dev route IDs ({§observability-genai-conventions}).
const PROVIDER_NAMES: ReadonlyMap<string, string> = new Map([
    ["google", "gcp.gemini"],
    ["amazon-bedrock", "aws.bedrock"],
    ["moonshotai", "moonshot_ai"],
    ["moonshotai-cn", "moonshot_ai"],
    ["xai", "x_ai"],
    ["mistral", "mistral_ai"],
]);

export const genAiRequestOptions = (
    provider: string,
    model: string,
): {
    readonly kind: typeof SpanKind.CLIENT;
    readonly attributes: Record<string, string>;
} => ({
    kind: SpanKind.CLIENT,
    attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": PROVIDER_NAMES.get(provider) ?? provider,
        "gen_ai.request.model": model,
    },
});

// Settle the response-side convention attributes from the validated
// accounting: token quantities and the finish reason only — never prompts,
// bodies, or reasoning content ({§observability-boundary}).
export const settleGenAiResponse = (span: Span, response: ProviderResponse): void => {
    const { usage } = aggregateProviderAccounting(response.accounting);
    if (usage?.inputTokens !== undefined) {
        span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
    }
    if (usage?.outputTokens !== undefined) {
        span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
    }
    const finish = response.assistant.finishReason;
    if (finish !== null && finish !== undefined) {
        span.setAttribute("gen_ai.response.finish_reasons", [finish]);
    }
};
