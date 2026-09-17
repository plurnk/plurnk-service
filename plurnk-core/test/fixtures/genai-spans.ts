import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "../intg/_helpers.ts";
import { mountMemoryTracing } from "../intg/_observe-memory.ts";

// Emitted by the engine, not hand-authored convention samples. No provider network calls.
export const recordGenAiSpans = async () => {
    const memory = await mountMemoryTracing();
    const db = await openMigrated();
    try {
        const samples = [];
        for (const providerId of ["openai", "anthropic", "deepseek", "google", "amazon-bedrock", "moonshotai", "moonshotai-cn", "xai", "mistral", "custom-endpoint", undefined]) {
            const provider = new Mock({ contextWindow: 32_768, responses: [{
                assistant: { content: "````BARE\nprivate question\n````\n\n````BARE\nprivate failure\n````", reasoning: null },
                usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            }] });
            const child = new Mock({ contextWindow: 16_384, responses: [{
                assistant: { content: "private answer", reasoning: "private reasoning" },
                usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            }] });
            if (providerId !== undefined) {
                for (const handle of [provider, child]) {
                    ProviderInstantiate.registerInstance(handle, { provider: providerId, model: handle.model, alias: "private-tuning" });
                }
            }
            const workspaceId = await insertWorkspace(db, `observe-${providerId ?? "unregistered"}`);
            const workerId = await insertWorker(db, workspaceId);
            const loopId = await insertLoop(db, workerId, 1, "private prompt");
            const before = memory.spans().length;
            const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
                workspaceId, workerId, loopId, messages: [], provider, childProvider: child,
            });
            const spans = memory.spans().slice(before).filter((span) => span.attributes["gen_ai.operation.name"] === "chat");
            samples.push({ providerId, result, spans });
        }
        return samples;
    } finally {
        try { await db.close(); } finally { await memory.shutdown(); }
    }
};

// Optional Weaver JSON fixture: see test/fixtures/genai-spans.md.
if (import.meta.main) {
    const samples = await recordGenAiSpans();
    console.log(JSON.stringify(samples.flatMap(({ spans }) => spans.map((span) => ({
        span: {
            name: span.name,
            kind: SpanKind[span.kind].toLowerCase(),
            status: { code: SpanStatusCode[span.status.code].toLowerCase(), message: span.status.message ?? "" },
            attributes: Object.entries(span.attributes).map(([name, value]) => ({ name, value })),
            span_events: span.events.map(({ name, attributes }) => ({
                name, attributes: Object.entries(attributes ?? {}).map(([name, value]) => ({ name, value })),
            })),
        },
    }))), null, 2));
}
