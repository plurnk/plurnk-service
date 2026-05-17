import type { PlurnkStatement } from "@plurnk/plurnk-grammar";

export type MockAssistant = {
    tokens: number;
    content: string;
    ops: PlurnkStatement[];
    reasoning: string | null;
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

export default class Mock {
    #contextSize: number;
    #queue: MockResponse[];

    constructor({ contextSize, responses }: { contextSize: number; responses: MockResponse[] }) {
        this.#contextSize = contextSize;
        this.#queue = [...responses];
    }

    get contextSize(): number { return this.#contextSize; }

    async generate(_: { prompt: string }): Promise<{ assistant: MockAssistant; assistantRaw: unknown }> {
        const next = this.#queue.shift();
        if (next === undefined) throw new Error("Mock provider exhausted: no more queued responses");
        return { assistant: next.assistant, assistantRaw: next.assistantRaw ?? null };
    }

    get remaining(): number { return this.#queue.length; }
}
