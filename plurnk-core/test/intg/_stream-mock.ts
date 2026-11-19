import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { parseLogRecords } from "../LogRecords.ts";
import { mcpToolCalls, userText } from "./_mock.ts";

// Follow the emitted resource address, not the causal log coordinate.
export default class StreamMock extends Mock {
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!/\$(?:STREAM|INVOCATION)/u.test(response.assistant.content)) return response;
        const text = userText(args[0].messages);
        const match = /"stream"\s*:\s*"(exec:\/\/\/([a-z][a-z0-9+._-]*)\/[a-f0-9]{8})(?:#|")/.exec(text);
        const stream = match?.[1];
        const runtime = match?.[2];
        assert.ok(stream && runtime, "the next program follows an execution address actually delivered to the model");
        let content = response.assistant.content.replaceAll("$STREAM", stream);
        if (content.includes("$INVOCATION")) {
            const invocation = parseLogRecords(text).find((row) => row.stream === stream && row.logPath.endsWith(`/${runtime}`));
            assert.ok(invocation, "the next program follows the invocation's actual log address");
            content = content.replaceAll("$INVOCATION", invocation.logPath);
        }
        const { ops: _ops, ...assistant } = response.assistant;
        return {
            ...response,
            assistant: {
                ...assistant,
                content: "",
                finishReason: "tool_calls",
                toolCalls: mcpToolCalls(content),
            },
        };
    }
}
