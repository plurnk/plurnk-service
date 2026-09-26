// {§repetition-stop}: counts the complete lines one stream channel emits. The first line of 16 or more
// characters to appear `limit` times is a repetition, and the stream stops there. Shorter lines — braces,
// bullets, blank separators — legitimately recur.
export default class RepeatedLine {
    readonly #limit: number;
    readonly #counts = new Map<string, number>();
    #pending = "";

    constructor(limit: number) {
        this.#limit = limit;
    }

    push(delta: string): { readonly line: string; readonly count: number } | null {
        this.#pending += delta;
        const lines = this.#pending.split("\n");
        this.#pending = lines.pop()!;
        for (const raw of lines) {
            const line = raw.trim();
            if (line.length < 16) continue;
            const count = (this.#counts.get(line) ?? 0) + 1;
            this.#counts.set(line, count);
            if (count >= this.#limit) return { line, count };
        }
        return null;
    }
}
