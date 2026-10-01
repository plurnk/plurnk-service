import PlurnkParser from "./PlurnkParser.ts";

// {§parser-reasoning-frontier}: inspect complete lines in order even when one transport delta
// carries several. Prose before a batch cannot change fence pairing.
export default class ReasoningStream {
    #checked = 0;
    #pending = false;
    #end: number | undefined;

    inspect(source: string, complete = false): number | undefined {
        if (this.#end !== undefined) return this.#end;
        for (;;) {
            const newline = source.indexOf("\n", this.#checked);
            if (newline === -1) break;
            const line = source.slice(this.#checked, newline + 1);
            this.#checked = newline + 1;
            if (!this.#pending && !/`{3}|~{3}/u.test(line)) continue;
            const result = PlurnkParser.reasoningBoundary(source.slice(0, this.#checked), false);
            this.#pending = result.pending;
            if (result.end !== undefined) return this.#end = result.end;
        }
        if (complete) this.#end = PlurnkParser.reasoningBoundary(source, true).end;
        return this.#end;
    }
}
