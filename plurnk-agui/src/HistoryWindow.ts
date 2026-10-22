// {§agui-history} {§agui-history-window} {§agui-history-page} The window a snapshot holds and each page before it, cut from one complete
// projection: between whole turns of the bound worker's newest loops, within a ceiling on what one snapshot or page
// serializes to. A turn larger than the ceiling is cut between its parts; a call and its results are one part. A part
// that alone would pass the ceiling carries the words a sender wrote by reference ({§agui-words-by-reference}).
import { EventType, type ContentPart, type Message } from "@ag-ui/core";
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
// that worker's own, and whether it is an accepted message of a live loop not yet observed, which always travels.
interface Place {
    readonly turn: string;
    readonly part: number;
    readonly loop: number | null;
    readonly pending: boolean;
}

const CONCLUDED = new Set<unknown>(["completed", "cancelled", "failed"]);

const plurnkFacts = (metadata: unknown): Readonly<Record<string, unknown>> | null =>
    isRecord(metadata) && isRecord(metadata.plurnk) ? metadata.plurnk : null;

// A message's log coordinate, `L/T/S`, or `L/T` for its turn's reasoning: its call's, when it is a call.
const coordinateOf = (message: Message): string | null => {
    const call = message.role === "assistant" ? message.toolCalls?.[0] : undefined;
    const coordinate = plurnkFacts(call === undefined ? (message as { metadata?: unknown }).metadata : call.metadata)?.coordinate;
    return typeof coordinate === "string" ? coordinate : null;
};

export default class HistoryWindow {
    // The complete projection, each part that alone would pass the ceiling carrying its words by reference.
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

    // `references` holds, by message id, the reference form of the words a sender wrote; `envelope` is what a snapshot
    // adds around messages from a position.
    constructor(messages: readonly Message[], limits: HistoryLimits,
        references: ReadonlyMap<string, readonly ContentPart[]> = new Map(), envelope: (start: number) => number = () => 0) {
        this.#limits = limits;
        this.#places = HistoryWindow.#placesOf(messages);
        this.#messages = HistoryWindow.#referenced(messages, this.#places, limits.chars, references, envelope);
        const sums = [0];
        for (const message of this.#messages) sums.push(sums[sums.length - 1] + JSON.stringify(message).length);
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

    // {§agui-words-by-reference} The projection with each part that alone, in a snapshot of its own, would pass the ceiling
    // carrying its senders' words by reference.
    static #referenced(messages: readonly Message[], places: readonly Place[], chars: number,
        references: ReadonlyMap<string, readonly ContentPart[]>, envelope: (start: number) => number): Message[] {
        const parts = new Map<number, number[]>();
        places.forEach(({ part }, index) => parts.set(part, [...parts.get(part) ?? [], index]));
        const referenced = [...messages];
        for (const members of parts.values()) {
            if (!members.some((index) => references.has(messages[index].id))) continue;
            const size = members.reduce((total, index) => total + JSON.stringify(messages[index]).length + 1, -1);
            if (envelope(members[0]) + size <= chars) continue;
            for (const index of members) {
                const message = messages[index];
                const reference = references.get(message.id);
                if (reference !== undefined && (message.role === "user" || message.role === "tool")) referenced[index] = { ...message, content: [...reference] };
            }
        }
        return referenced;
    }

    // Each message's place. A result is its call's part: the snapshot puts it after its call and the results beside it.
    static #placesOf(messages: readonly Message[]): Place[] {
        const places: Place[] = [];
        const calls = new Map<string, Place>();
        let part = -1;
        let currentLoop: number | null = null;
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
            const ownLoop = scope === "" && loop !== null && Number.isSafeInteger(loop) ? loop : null;
            if (ownLoop !== null) currentLoop = ownLoop;
            const facts = plurnkFacts(message.metadata);
            const unpublished = coordinate === null && message.role === "user" && facts?.published === false;
            const concluded = unpublished && CONCLUDED.has(facts?.lifecycle);
            const place: Place = {
                turn: coordinate === null ? `message|${message.id}` : `${scope}|${loop}/${turn}`,
                part,
                loop: concluded ? currentLoop : ownLoop,
                pending: unpublished && !concluded,
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

    // {§agui-loop-page} The bound worker's loop `sequence`: from its first message to the next loop's first, every subagent
    // message among them, never the accepted messages not yet observed; null when the projection holds no such loop.
    loopSpan(sequence: number): HistoryCut | null {
        const start = this.#places.findIndex(({ loop }) => loop === sequence);
        if (start === -1 || start >= this.#pending) return null;
        let end = start + 1;
        while (end < this.#pending && (this.#places[end].loop === null || this.#places[end].loop === sequence)) end++;
        return { start, end };
    }

    // Where the accepted messages the worker has not yet observed begin.
    get pending(): number { return this.#pending; }

    // The projection the window and its pages are cut from.
    get messages(): readonly Message[] { return this.#messages; }

    // {§agui-history-window} A snapshot's serialized length beyond its messages, with `older` the link it carries.
    static snapshotEnvelope(older: string | null): number {
        return JSON.stringify({ type: EventType.MESSAGES_SNAPSHOT, messages: [], metadata: { plurnk: { history: { older } } } }).length;
    }

    // {§agui-history-page} A page's serialized length beyond its messages.
    static pageEnvelope(older: string | null): number {
        return JSON.stringify({ final: false, messages: [], older }).length;
    }
}
