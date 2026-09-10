import assert from "node:assert/strict";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";

// Follow the emitted resource address, not the causal log coordinate.
export default class StreamMock extends Mock {
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const response = await super.generate(...args);
        if (!response.assistant.content.includes("$STREAM")) return response;
        const text = args[0].messages.map(chatMessageText).join("\n");
        const stream = /"stream"\s*:\s*"([a-z][a-z0-9+.-]*:\/\/\/[a-f0-9]{8})(?:#|")/.exec(text)?.[1];
        assert.ok(stream, "the next program follows an execution address actually delivered to the model");
        const { ops: _ops, ...assistant } = response.assistant;
        return { ...response, assistant: { ...assistant, content: assistant.content.replaceAll("$STREAM", stream) } };
    }
}
