export type ReasoningEnvelope = readonly [opening: string, closing: string];

// {§provider-tagged-reasoning} One leading envelope, shared by incremental
// observation and settled response projection. Only an undecided delimiter is held.
export default class LeadingReasoning {
    static readonly THINK: readonly ReasoningEnvelope[] = [["<think>", "</think>"]];
    static readonly TEMPLATE: readonly ReasoningEnvelope[] = [
        ["<|channel>thought\n", "<channel|>"],
        ["<think>\n", "</think>"],
    ];

    readonly #envelopes: readonly ReasoningEnvelope[];
    #pending = "";
    #closing: string | null = null;
    #closed = false;
    #projected = false;
    #reasoning = "";
    #content = "";
    #contentStart = 0;

    constructor(envelopes: readonly ReasoningEnvelope[]) {
        this.#envelopes = envelopes;
    }

    push(text: string): string {
        if (this.#closed) {
            this.#content += text;
            return "";
        }
        this.#pending += text;
        if (this.#closing === null) {
            const envelope = this.#envelopes.find(([opening]) => this.#pending.startsWith(opening));
            if (envelope === undefined) {
                if (!this.#envelopes.some(([opening]) => opening.startsWith(this.#pending))) {
                    this.#content = this.#pending;
                    this.#pending = "";
                    this.#closed = true;
                }
                return "";
            }
            const [opening, closing] = envelope;
            this.#pending = this.#pending.slice(opening.length);
            this.#closing = closing;
            this.#projected = true;
            this.#contentStart = [...opening].length;
        }
        const end = this.#pending.indexOf(this.#closing);
        if (end !== -1) {
            const delta = this.#emit(this.#pending.slice(0, end));
            this.#contentStart += [...this.#closing].length;
            this.#content = this.#pending.slice(end + this.#closing.length);
            this.#pending = "";
            this.#closed = true;
            return delta;
        }
        let held = Math.min(this.#pending.length, this.#closing.length - 1);
        while (held > 0 && !this.#pending.endsWith(this.#closing.slice(0, held))) held--;
        const split = this.#pending.length - held;
        const delta = this.#emit(this.#pending.slice(0, split));
        this.#pending = this.#pending.slice(split);
        return delta;
    }

    finish(): string {
        const delta = this.#projected ? this.#emit(this.#pending) : "";
        if (!this.#projected) this.#content += this.#pending;
        this.#pending = "";
        this.#closed = true;
        return delta;
    }

    #emit(delta: string): string {
        this.#reasoning += delta;
        this.#contentStart += [...delta].length;
        return delta;
    }

    static project(content: string, reasoning: string, envelopes: readonly ReasoningEnvelope[]): {
        content: string; reasoning: string; projected: boolean; contentStart: number;
    } {
        if (reasoning.length > 0) return { content, reasoning, projected: false, contentStart: 0 };
        const parser = new LeadingReasoning(envelopes);
        parser.push(content);
        parser.finish();
        return { content: parser.#content, reasoning: parser.#reasoning, projected: parser.#projected, contentStart: parser.#contentStart };
    }
}
