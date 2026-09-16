import assert from "node:assert/strict";
import test from "node:test";
import { SdkError, SdkErrorCode, type InputRequiredResult } from "@modelcontextprotocol/client";
import type { ClientInteractionResolution } from "@plurnk/plurnk-contracts";
import { runInputRequiredRequest } from "./inputRequired.ts";

const input: InputRequiredResult = {
    resultType: "input_required",
    requestState: "opaque",
    inputRequests: {
        profile: {
            method: "elicitation/create",
            params: {
                mode: "form", message: "Choose a name.",
                requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
        },
    },
};
const answer: ClientInteractionResolution = {
    status: "resolved", payload: { profile: { action: "accept", content: { name: "Ada" } } },
};

test("{§mcp-input-deadline}: another MRTR round consumes the original budget and a late answer cannot retry", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const waiting = Promise.withResolvers<AbortSignal>();
    const late = Promise.withResolvers<ClientInteractionResolution>();
    const budgets: number[] = [];
    let rounds = 0;
    const operation = runInputRequiredRequest({
        server: "fixture", operation: "tools/call", originalParams: { name: "review" }, timeout: 1000,
        requestLeg: async (_params, options) => {
            budgets.push(options.maxTotalTimeout);
            return input;
        },
        interact: async (_request, signal) => {
            assert.ok(signal);
            if (++rounds === 1) {
                t.mock.timers.tick(600);
                return answer;
            }
            waiting.resolve(signal);
            return late.promise;
        },
    });
    const failed = assert.rejects(operation, (error: unknown) => SdkError.isInstance(error)
        && error.code === SdkErrorCode.RequestTimeout && /operation timeout/u.test(error.message));
    const signal = await waiting.promise;
    t.mock.timers.tick(399);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await failed;
    late.resolve(answer);
    await Promise.resolve();
    assert.deepEqual(budgets, [1000, 400]);
    assert.equal(rounds, 2);
});

test("{§mcp-input-deadline}: answered input clears its deadline without cancelling later work", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    let inputSignal: AbortSignal | undefined;
    let calls = 0;
    const result = await runInputRequiredRequest<{ resultType: "complete" }>({
        server: "fixture", operation: "tools/call", originalParams: { name: "review" }, timeout: 1000,
        requestLeg: async () => ++calls === 1 ? input : { resultType: "complete" },
        interact: async (_request, signal) => {
            inputSignal = signal;
            t.mock.timers.tick(900);
            return answer;
        },
    });
    assert.equal(result.resultType, "complete");
    assert.ok(inputSignal);
    t.mock.timers.tick(1000);
    assert.equal(inputSignal.aborted, false);
    assert.equal(calls, 2);
});
