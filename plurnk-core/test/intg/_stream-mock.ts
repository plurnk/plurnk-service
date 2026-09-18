import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { parseLogRecords } from "../LogRecords.ts";

// Follow the emitted resource address, not the causal log coordinate.
export default class StreamMock extends Mock {
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!/\$(?:STREAM|INVOCATION)/u.test(response.assistant.content)) return response;
        const text = args[0].messages.map(chatMessageText).join("\n");
        const stream = /"stream"\s*:\s*"([a-z][a-z0-9+.-]*:\/\/\/[a-f0-9]{8})(?:#|")/.exec(text)?.[1];
        assert.ok(stream, "the next program follows an execution address actually delivered to the model");
        let content = response.assistant.content.replaceAll("$STREAM", stream);
        if (content.includes("$INVOCATION")) {
            const log = /(?:^|\n)## Log\n([\s\S]*?)(?=\n## |$)/u.exec(text)?.[1];
            assert.ok(log, "the actual request contains the log");
            const runtime = new URL(stream).protocol.slice(0, -1);
            const invocation = parseLogRecords(log.trim()).find((row) => row.stream === stream && String(row.logPath).endsWith(`/${runtime}`));
            assert.ok(invocation, "the next program follows the invocation's actual log address");
            content = content.replaceAll("$INVOCATION", String(invocation.logPath));
        }
        const { ops: _ops, ...assistant } = response.assistant;
        return { ...response, assistant: { ...assistant, content } };
    }
}
