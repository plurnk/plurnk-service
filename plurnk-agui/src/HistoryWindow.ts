// {§agui-history} {§agui-history-window} {§agui-history-page} The window a snapshot holds and each page before it, cut from one complete
// projection: between whole turns of the bound worker's newest loops, within a ceiling on what one snapshot or page
// serializes to. A turn larger than the ceiling is cut between its parts; a call and its results are one part.
import { EventType, type Message } from "@ag-ui/core";
import { isRecord } from "@plurnk/plurnk-contracts";

/** {§agui-history-window} What a window and its pages may hold. */
export interface HistoryLimits {
    /** The bound worker's newest loops a snapshot holds. */
    readonly loops: number;
    /** The most characters one snapshot or page serializes to. */
    readonly chars: number;
}

/** {§agui-history-page} A page of history: messages `[start, end)` of the complete projection. */
export interface HistoryCut {
    readonly start: number;
    readonly end: number;
}

// Where a message sits: its turn, the part of that turn it begins or continues, the bound worker's loop when the message is
// that worker's own, and whether it is an accepted message the worker has not yet observed, which always travels.
interface Place {
    readonly turn: string;
    readonly part: number;
    readonly loop: number | null;
    readonly pending: boolean;
}

const plurnkFacts = (metadata: unknown): Readonly<Record<string, unknown>> | null =>
    isRecord(metadata) && isRecord(metadata.plurnk) ? metadata.plurnk : null;

// A message's log coordinate, `L/T/S`, or `L/T` for its turn's reasoning: its call's, when it is a call.
const coordinateOf = (message: Message): string | null => {
    const call = message.role === "assistant" ? message.toolCalls?.[0] : undefined;
    const coordinate = plurnkFacts(call === undefined ? (message as { metadata?: unknown }).metadata : call.metadata)?.coordinate;
    return typeof coordinate === "string" ? coordinate : null;
};

export default class HistoryWindow {
    readonly #messages: readonly Message[];
    readonly #limits: HistoryLimits;
    readonly #places: readonly Place[];
    // Prefix sums of each message's serialized length.
    readonly #sums: readonly number[];
    // Per position: the turns that span a cut there, every one and those within the ceiling.
    readonly #spanning: readonly number[];
    readonly #spanningSmall: readonly number[];
    // Where the accepted messages the worker has not yet observed begin: no cut falls after it.
    readonly #pending: number;

    constructor(messages: readonly Message[], limits: HistoryLimits) {
        this.#messages = messages;
        this.#limits = limits;
        this.#places = HistoryWindow.#placesOf(messages);
        const sums = [0];
        for (const message of messages) sums.push(sums[sums.length - 1] + JSON.stringify(message).length);
        this.#sums = sums;
        const pending = this.#places.findIndex(({ pending: unobserved }) => unobserved);
        this.#pending = pending === -1 ? messages.length : pending;
        const first = new Map<string, number>();
        const last = new Map<string, number>();
        this.#places.forEach(({ turn }, index) => {
            if (!first.has(turn)) first.set(turn, index);
            last.set(turn, index);
        });
        // A turn spans a cut at i when it has messages before i and at or after i: first < i ≤ last.
        const spanning = Array.from({ length: messages.length + 2 }, () => 0);
        const spanningSmall = Array.from({ length: messages.length + 2 }, () => 0);
        for (const [turn, from] of first) {
            const to = last.get(turn)!;
            if (to === from) continue;
            const small = this.#size(from, to + 1) <= limits.chars;
            spanning[from + 1] += 1;
            spanning[to + 1] -= 1;
            if (small) {
                spanningSmall[from + 1] += 1;
                spanningSmall[to + 1] -= 1;
            }
        }
        for (let index = 1; index < spanning.length; index++) {
            spanning[index] += spanning[index - 1];
            spanningSmall[index] += spanningSmall[index - 1];
        }
        this.#spanning = spanning;
        this.#spanningSmall = spanningSmall;
    }

    // Each message's place. A result is its call's part: the snapshot puts it after its call and the results beside it.
    static #placesOf(messages: readonly Message[]): Place[] {
        const places: Place[] = [];
        const calls = new Map<string, Place>();
        let part = -1;
        for (const message of messages) {
            const call = message.role === "tool" ? calls.get(message.toolCallId) : undefined;
            if (call !== undefined) {
                places.push(call);
                continue;
            }
            part += 1;
            const scope = (message as { subagentRunId?: string }).subagentRunId ?? "";
            const coordinate = coordinateOf(message);
            const [loop, turn] = coordinate === null ? [null, null] : coordinate.split("/").map(Number);
            const place: Place = {
                turn: coordinate === null ? `message|${message.id}` : `${scope}|${loop}/${turn}`,
                part,
                loop: scope === "" && loop !== null && Number.isSafeInteger(loop) ? loop : null,
                pending: coordinate === null && message.role === "user" && plurnkFacts(message.metadata)?.published === false,
            };
            places.push(place);
            if (message.role === "assistant") for (const { id } of message.toolCalls ?? []) calls.set(id, place);
        }
        return places;
    }

    // The serialized length of messages [from, to) as an array's items.
    #size(from: number, to: number): number {
        return to <= from ? 0 : this.#sums[to] - this.#sums[from] + (to - from - 1);
    }

    // A cut at `index` keeps every turn whole, or falls between the parts of turns each larger than the ceiling.
    #cuts(index: number): boolean {
        if (index <= 0 || index >= this.#messages.length) return true;
        if (this.#spanning[index] === 0) return true;
        return this.#places[index].part !== this.#places[index - 1].part && this.#spanningSmall[index] === 0;
    }

    // {§agui-history-window} The first message the window holds: the bound worker's newest loops, back to the nearest cut,
    // then forward to the first cut whose snapshot fits; `envelope` is what the snapshot adds around messages from there.
    window(envelope: (start: number) => number): number {
        const end = this.#pending;
        const seen: number[] = [];
        for (let index = end - 1; index >= 0 && seen.length <= this.#limits.loops; index--) {
            const { loop } = this.#places[index];
            if (loop !== null && !seen.includes(loop)) seen.push(loop);
        }
        let start = seen.length > this.#limits.loops ? this.#places.findIndex(({ loop }) => loop === seen[this.#limits.loops - 1]) : 0;
        while (start > 0 && !this.#cuts(start)) start--;
        const fits = (from: number): boolean => envelope(from) + this.#size(from, this.#messages.length) <= this.#limits.chars;
        while (start < end && !(this.#cuts(start) && fits(start))) start++;
        return start;
    }

    // {§agui-history-page} The page before `end`: the loop of the bound worker's newest message there, whole, back to the
    // nearest cut, then forward to the first cut whose page fits; a part that alone passes the ceiling is a page of its own.
    page(end: number, envelope: (start: number) => number): HistoryCut {
        let loop: number | null = null;
        for (let index = end - 1; index >= 0 && loop === null; index--) loop = this.#places[index].loop;
        let start = loop === null ? 0 : this.#places.findIndex((place) => place.loop === loop);
        while (start > 0 && !this.#cuts(start)) start--;
        const fits = (from: number): boolean => envelope(from) + this.#size(from, end) <= this.#limits.chars;
        while (start < end && !(this.#cuts(start) && fits(start))) start++;
        if (start === end && end > 0) {
            start = end - 1;
            while (start > 0 && this.#places[start].part === this.#places[start - 1].part) start--;
        }
        return { start, end };
    }

    // {§agui-history-page} Whether every call in `[start, end)` holds its result there.
    settled({ start, end }: HistoryCut): boolean {
        const answered = new Set(this.#messages.slice(start, end).flatMap((message) => message.role === "tool" ? [message.toolCallId] : []));
        return this.#messages.slice(start, end).every((message) => message.role !== "assistant"
            || (message.toolCalls ?? []).every(({ id }) => answered.has(id)));
    }

    // The bound worker's loop that `[start, end)` belongs to: the loop of its newest message of that worker.
    loopOf({ start, end }: HistoryCut): number | null {
        for (let index = end - 1; index >= start; index--) {
            const { loop } = this.#places[index];
            if (loop !== null) return loop;
        }
        return null;
    }

    // Where the accepted messages the worker has not yet observed begin.
    get pending(): number { return this.#pending; }

    // {§agui-history-window} A snapshot's serialized length beyond its messages, with `older` the link it carries.
    static snapshotEnvelope(older: string | null): number {
        return JSON.stringify({ type: EventType.MESSAGES_SNAPSHOT, messages: [], metadata: { plurnk: { history: { older } } } }).length;
    }

    // {§agui-history-page} A page's serialized length beyond its messages.
    static pageEnvelope(older: string | null): number {
        return JSON.stringify({ final: false, messages: [], older }).length;
    }
}
