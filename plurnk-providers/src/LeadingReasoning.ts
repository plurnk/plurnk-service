export type ReasoningEnvelope = readonly [opening: string, closing: string];

// {§provider-interface} One leading envelope, shared by incremental
// observation and settled response projection. Only an undecided delimiter is held.
export default class LeadingReasoning {
    static readonly THINK: readonly ReasoningEnvelope[] = [["<think>", "</think>"]];

    readonly #envelopes: readonly ReasoningEnvelope[];
    #pending = "";
    #closing: string | null = null;
    #closed = false;
    #projected = false;
    #reasoning = "";
    #content = "";

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
        }
        const end = this.#pending.indexOf(this.#closing);
        if (end !== -1) {
            const delta = this.#emit(this.#pending.slice(0, end));
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
        return delta;
    }

    static project(content: string, reasoning: string, envelopes: readonly ReasoningEnvelope[]): {
        content: string; reasoning: string; projected: boolean;
    } {
        if (reasoning.length > 0) {
            for (const [opening, closing] of envelopes) {
                const closeIdx = content.indexOf(closing);
                if (closeIdx !== -1 && !content.slice(0, closeIdx).includes(opening)) {
                    return {
                        content: content.slice(closeIdx + closing.length).replace(/^\r?\n+/u, ""),
                        reasoning: reasoning + content.slice(0, closeIdx),
                        projected: true,
                    };
                }
            }
            return { content, reasoning, projected: false };
        }
        const parser = new LeadingReasoning(envelopes);
        parser.push(content);
        parser.finish();
        return { content: parser.#content, reasoning: parser.#reasoning, projected: parser.#projected };
    }
}
