import test from "node:test";
import assert from "node:assert/strict";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { recordGenAiSpans } from "../fixtures/genai-spans.ts";

test("{§observability-genai-conventions} normal and BARE calls export provider identity, accounting, and redacted failures", async () => {
    const expectedProviders = ["openai", "anthropic", "deepseek", "gcp.gemini", "aws.bedrock", "moonshot_ai", "moonshot_ai", "x_ai", "mistral_ai", "custom-endpoint", "other"];
    const samples = await recordGenAiSpans();
    assert.equal(samples.length, expectedProviders.length);
    for (const [index, { providerId, result, spans }] of samples.entries()) {
        assert.equal(result.status, 102);
        assert.deepEqual(result.outcomes.map(({ status }) => status), [200, 502], `${providerId}: one BARE succeeds and the exhausted BARE provider fails`);
        assert.equal(spans.length, 3, `${providerId}: one main call and two BARE calls`);
        for (const span of spans) {
            assert.equal(span.kind, SpanKind.CLIENT);
            assert.equal(span.name, "chat mock");
            assert.equal(span.attributes["gen_ai.request.model"], "mock");
            assert.equal(span.attributes["gen_ai.provider.name"], expectedProviders[index]);
            assert.equal(span.attributes["gen_ai.system"], undefined);
            assert.equal(span.attributes.attempt, 1);
            assert.equal(span.events.length, 0);
            assert.doesNotMatch(JSON.stringify(span.attributes), /private-|private /);
        }
        const main = spans.find((span) => span.attributes.kind !== "bare");
        assert.ok(main);
        assert.equal(main.attributes["gen_ai.usage.input_tokens"], 12);
        assert.equal(main.attributes["gen_ai.usage.output_tokens"], 8);
        const bare = spans.filter((span) => span.attributes.kind === "bare");
        const success = bare.find((span) => span.status.code === SpanStatusCode.UNSET);
        assert.ok(success);
        assert.equal(success.attributes["gen_ai.usage.input_tokens"], 5);
        assert.equal(success.attributes["gen_ai.usage.output_tokens"], 3);
        assert.deepEqual(success.attributes["gen_ai.response.finish_reasons"], ["stop"]);
        const failure = bare.find((span) => span.status.code === SpanStatusCode.ERROR);
        assert.ok(failure);
        assert.equal(failure.attributes["error.type"], "ProviderError");
        assert.equal(failure.attributes["gen_ai.usage.input_tokens"], undefined);
        assert.equal(failure.attributes["gen_ai.response.finish_reasons"], undefined);
        assert.equal(failure.status.message, undefined, "provider error text stays outside telemetry");
    }
});
