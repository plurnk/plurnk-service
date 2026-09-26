// {§fence-pairing} — which fence line opens a block, which one closes it, and where a missing
// closer is supplied, decided once for the whole input before the lexer reads it. The ANTLR
// grammar cannot make this decision efficiently: it depends on the rest of the input, and ALL(*)
// full-context predictions are uncached ({§parser-architecture}). The specification of the search
// below — its alphabet, its preference order and its repair cost — is {§fence-pairing}.

export type FenceCharacter = "`" | "~";

// {§forgotten-tag}: an operation heading on the line under a bare fence, as the heading it would be.
type Split = { readonly selfClosed: boolean; readonly bodiless: boolean; readonly terminal: boolean; readonly runtime: string | null };

type Line =
    | { readonly kind: "text"; readonly blank?: boolean }
    | { readonly kind: "bare"; readonly character: FenceCharacter; readonly width: number; readonly underFence: boolean; readonly split?: Split }
    | { readonly kind: "info"; readonly character: FenceCharacter; readonly width: number }
    | { readonly kind: "heading"; readonly width: number; readonly selfClosed: boolean; readonly bodiless: boolean; readonly terminal: boolean; readonly runtime: string | null }
    | { readonly kind: "closeThenHeading"; readonly width: number; readonly headingWidth: number; readonly selfClosed: boolean; readonly bodiless: boolean }
    | { readonly kind: "name"; readonly name: string };

/** How one top-level block (an operation or a quotation) ends. */
export type BlockEnd =
    | { readonly kind: "closer"; readonly line: number; readonly offset: number }
    | { readonly kind: "before"; readonly line: number; readonly offset: number }
    | { readonly kind: "end" };

export type Pairing = {
    /** Keyed by the code-point offset of the line that opens a top-level block. */
    readonly ends: ReadonlyMap<number, BlockEnd>;
    /** Code-point offsets of fence lines read as text: surplus fences ({§fence-pairing} repair). */
    readonly surplus: ReadonlySet<number>;
    /** Code-point offsets of top-level fence lines that open a quotation. */
    readonly quotations: ReadonlySet<number>;
    /** Code-point offsets of top-level bare fences whose next line is the operation they open ({§forgotten-tag}). */
    readonly splits: ReadonlySet<number>;
    /** Missing closers supplied, as line indexes they precede (the input length for the end). */
    readonly repairs: readonly number[];
    /** Fence lines read as content, by line index (the objective's second term). */
    readonly demotions: number;
    /** Operation headings read as text: operations the author wrote that will not run. */
    readonly hidden: number;
    readonly lineStarts: readonly number[];
    /** Code-point offsets of heading lines that close their block on the same line. */
    readonly selfClosed: ReadonlySet<number>;
    /** Line classification, for diagnostics and witnesses. */
    readonly lines: readonly string[];
};

export type PairingOptions = {
    readonly operations: ReadonlySet<string>;
    readonly executors: ReadonlySet<string>;
    /** {§reasoning-notes} — reasoning opens only NOTE; everything else quotes. */
    readonly reasoning: boolean;
    /** Whether a heading line closes its block on that line, decided by the heading lexer itself
     * (targets, metadata strings and asides may hold backticks that close nothing). */
    readonly closesOnLine: (heading: string) => boolean;
    /** {§pairing-objective}: whether a body is well-formed in its runtime's declared media type; absent, or
     * true for a runtime with none, is no opinion. */
    readonly wellFormed?: (runtime: string, body: string) => boolean;
};

const NAME = /^[A-Za-z0-9_.+-]+/u;

// Decided ahead of the grammar because a fence's role depends on every fence after it ({§pairing-need}).
export default class FencePairing {
    static pair(input: string, options: PairingOptions): Pairing {
        const { lines, lineStarts } = FencePairing.#classify(input, options);
        const solved = new Search(lines, input.split("\n"), options.wellFormed).solve();
        if (solved === null) throw new Error("fence pairing found no reading");
        const { result } = solved;
        const [, hidden, , demotions] = solved.cost;
        const ends = new Map<number, BlockEnd>();
        for (const [line, end] of result.ends) {
            ends.set(lineStarts[line]!, end.kind === "end" ? end
                : { ...end, offset: end.line < lineStarts.length ? lineStarts[end.line]! : [...input].length });
        }
        return {
            ends,
            surplus: new Set(result.surplus.map((line) => lineStarts[line]!)),
            quotations: new Set(result.quotations.map((line) => lineStarts[line]!)),
            splits: new Set(result.splits.map((line) => lineStarts[line]!)),
            repairs: result.repairs,
            demotions,
            hidden,
            lineStarts,
            selfClosed: new Set(lines.flatMap((line, index) => (line.kind === "heading" || line.kind === "closeThenHeading") && line.selfClosed ? [lineStarts[index]!] : [])),
            lines: lines.map((line) => line.kind === "text" ? "text" : line.kind === "name" ? `name ${line.name}` : line.kind === "heading" ? `heading ${line.width}${line.selfClosed ? " closed" : ""}` : line.kind === "closeThenHeading" ? `close ${line.width} then heading ${line.headingWidth}${line.selfClosed ? " closed" : ""}` : `${line.kind} ${line.character}${line.width}${line.kind === "bare" && line.underFence ? " under-fence" : ""}`),
        };
    }

    // Line classification mirrors the lexer's line-start rules: at most three spaces of indentation
    // and no tab ({§indented-fences}); a backtick fence whose info string holds a backtick is not a
    // fence (CommonMark 0.31.2 §4.5); a heading names a native operation or a known executor.
    static #classify(input: string, options: PairingOptions): { lines: Line[]; lineStarts: number[] } {
        const raw = input.split("\n");
        const lines: Line[] = [];
        const lineStarts: number[] = [];
        let start = 0;
        let previous = "";
        for (const text of raw) {
            lineStarts.push(start);
            start += [...text].length + 1;
            const line = FencePairing.#line(text.replace(/\r$/u, ""), options);
            // {§quotation}: the orphan is the closer of a heading written mid-line, in prose, that opened nothing —
            // a fence run on the line above that does not start it. A fence under a real closer is a surplus fence.
            lines.push(line.kind === "text" ? { kind: "text", blank: text.trim() === "" } : line.kind === "bare" ? { ...line, underFence: /\S[^`]*`{3,}/u.test(previous) && !/^ {0,3}`{3,}/u.test(previous) } : line);
            previous = text;
        }
        for (const [index, line] of lines.entries()) {
            if (line.kind !== "bare" || line.character !== "`" || /\S/u.test(raw[index]!.replace(/^ {0,3}`+/u, ""))) continue;
            const split = FencePairing.#split(raw[index]!.trim(), (raw[index + 1] ?? "").replace(/\r$/u, ""), options);
            if (split !== null) lines[index] = { ...line, split };
        }
        return { lines, lineStarts };
    }

    // {§forgotten-tag}: the line under a bare fence is an operation heading when it names a native operation
    // alone or with a slot, or a known executor with its operand (sh and env are words); reasoning opens none.
    static #split(fence: string, next: string, options: PairingOptions): Split | null {
        if (options.reasoning) return null;
        const name = NAME.exec(next)?.[0];
        if (name === undefined) return null;
        const native = options.operations.has(name);
        if (!native && !FencePairing.#known(name, options)) return null;
        const after = next.slice(name.length);
        const rest = after.trimStart();
        if (!(native ? rest === "" || /^[(<[]/u.test(rest) : rest.startsWith("("))) return null;
        const bodiless = FencePairing.#bodiless(name, after);
        return { selfClosed: options.closesOnLine(`${fence}${next}`), bodiless, terminal: name === "KILL" && !bodiless, runtime: native ? null : name };
    }

    // FIND, READ, COPY, MOVE and a targeted KILL take no body ({§matcher-body-redirect}, {§read-exact-target},
    // {§transfer-resource-selections}).
    static #bodiless(name: string, after: string): boolean {
        return ["FIND", "READ", "COPY", "MOVE"].includes(name) || name === "KILL" && /^[ \t]*\(/u.test(after);
    }

    static #known(name: string, options: PairingOptions): boolean {
        if (options.reasoning) return name === "NOTE";
        if (options.operations.has(name)) return true;
        const lower = name.toLowerCase();
        for (const executor of options.executors) if (executor.toLowerCase() === lower) return true;
        return false;
    }

    static #line(text: string, options: PairingOptions): Line {
        if (!options.reasoning && options.operations.has(text.trimEnd()) && /^[A-Z]+[ \t]*$/u.test(text)) return { kind: "name", name: text.trimEnd() };
        const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(text);
        if (match === null) return { kind: "text" };
        const character = match[2]!.charAt(0) as FenceCharacter;
        const width = match[2]!.length;
        const tail = match[3]!;
        if (tail.trim() === "" || /^[ \t]*<!--.*-->[ \t]*$/u.test(tail)) return { kind: "bare", character, width, underFence: false };
        if (character === "`") {
            // A closer glued to the next opener ({§inline-chain}): six backticks then READ is a close
            // then a heading when the run splits into a closer and a known opener.
            const glued = /^[ \t]*(`{3,})([A-Za-z0-9_.+-]+)(.*)$/u.exec(tail);
            if (glued !== null && FencePairing.#known(glued[2]!, options)) {
                const headingWidth = glued[1]!.length;
                return { kind: "closeThenHeading", width, headingWidth, selfClosed: options.closesOnLine(tail.trimStart()), bodiless: FencePairing.#bodiless(glued[2]!, glued[3]!) };
            }
            const name = NAME.exec(tail)?.[0];
            const after = name === undefined ? "" : tail.slice(name.length);
            const opens = name !== undefined && (after === "" || /^[ \t(<[]/u.test(after));
            if (opens && FencePairing.#known(name, options)) return { kind: "heading", width, selfClosed: options.closesOnLine(text.trimStart()), bodiless: FencePairing.#bodiless(name, after), terminal: name === "KILL" && !FencePairing.#bodiless(name, after), runtime: options.operations.has(name) ? null : name };
            if (tail.includes("`")) return { kind: "text" };
        }
        return { kind: "info", character, width };
    }

}

type End = { kind: "closer"; line: number } | { kind: "before"; line: number } | { kind: "end" };
type Result = { ends: Map<number, End>; surplus: number[]; quotations: number[]; splits: number[]; repairs: number[] };

// The objective, compared lexicographically ({§pairing-objective}): repairs (supplied closers, surplus fences,
// undersized closers accepted); then operation headings read as text (operations the author wrote that will
// not run); then supplied closers — among as few repairs, every block the author opened should end at a fence
// the author wrote; then other fence lines read as text. Equal cost goes to the reading whose first differing
// choice comes earlier in the preference order, which is how a repair lands at the earliest viable position.
type Cost = readonly [repairs: number, hidden: number, supplied: number, demoted: number];
const ZERO: Cost = [0, 0, 0, 0];
const add = (a: Cost, b: Cost): Cost => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const less = (a: Cost, b: Cost): boolean => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] !== b[2] ? a[2] < b[2] : a[3] < b[3];
const REPAIR: Cost = [1, 0, 0, 0];
const SUPPLY: Cost = [1, 0, 1, 0];
const HIDE: Cost = [0, 1, 0, 0];
const DEMOTE: Cost = [0, 0, 0, 1];

// An open block as its contents see it. `top`: it is the outermost block; `quoted`: it is or lies inside a
// quotation. Nothing else about the enclosing stack changes how its contents read.
type Context = {
    readonly kind: "operation" | "naked" | "nested" | "quotation";
    readonly character: FenceCharacter;
    readonly width: number;
    readonly bareOpened: boolean;
    readonly name: string;
    readonly top: boolean;
    readonly quoted: boolean;
    readonly bodiless?: boolean;
    // {§terminal-kill}: inside a parameterless KILL, at any depth, a heading is shown, never run.
    readonly terminal?: boolean;
    // An executor block whose body its runtime may judge, and the line it opened on.
    readonly runtime?: string;
    readonly opener?: number;
};
// What the contents read so far say about their block: whether it holds any line, and whether it holds a
// heading as an example ({§fence-heading-in-body}: such a block ends only at a real closer).
// `written`: it holds a line other than a blank one.
type Flags = { readonly empty: boolean; readonly holds: boolean; readonly written: boolean };
const FRESH: Flags = { empty: true, holds: false, written: false };

// A position is a line and a phase; the heading phase reads the rest of a line whose fence run closed a block.
const at = (line: number, heading = false): number => line * 2 + (heading ? 1 : 0);

type Effect = { readonly kind: "quotation" | "surplus" | "split" | "repair"; readonly line: number };
// One alternative at a position, in preference order: the block ends here (`end` is the position its parent
// resumes at), it continues at `next`, or it opens a child block and continues after the child ends.
type Move =
    | { readonly kind: "end"; readonly cost: Cost; readonly effects: readonly Effect[]; readonly end: number; readonly record: End }
    | { readonly kind: "stay"; readonly cost: Cost; readonly effects: readonly Effect[]; readonly next: number; readonly flags: Flags; readonly into?: Context | null; readonly opener?: number; readonly record?: End }
    | { readonly kind: "child"; readonly cost: Cost; readonly effects: readonly Effect[]; readonly child: Context; readonly line: number; readonly flags: Flags; readonly start?: number };

// A summary lists, for every position the block could end at, its cheapest reading of the rest of the block,
// ordered by the preference order of those readings.
type Entry = { readonly end: number; readonly cost: Cost; readonly key: readonly number[]; readonly move: Move; readonly via: readonly number[] };
type Summary = readonly Entry[];
// One summary under evaluation, with a cursor over the summaries it depends on.
type Frame = { readonly key: string; readonly position: number; readonly context: Context | null; readonly flags: Flags; moves: Move[] | null; move: number; entry: number };

// The pairing is a least-cost parse of the fence lines as a bracket language (Aho and Peterson's least-errors
// parse; {§pairing-algorithm}). A block's contents read the same whatever lies beneath it on the stack, so each
// (position, block context, flags) is summarized once — for each place the block could end, the cheapest reading
// up to there — and parents compose their children's summaries. The work is polynomial in the fence lines.
// Candidates are considered in preference order and replace one another only by costing strictly less, so each
// entry is the reading a preference-ordered exhaustive search would return.
class Search {
    readonly #lines: readonly Line[];
    readonly #nextFence: readonly number[];
    readonly #writtenRun: readonly boolean[];
    readonly #raw: readonly string[];
    readonly #check: ((runtime: string, body: string) => boolean) | undefined;
    readonly #verdicts = new Map<string, boolean>();
    readonly #memo = new Map<string, Summary>();

    constructor(lines: readonly Line[], raw: readonly string[], check: ((runtime: string, body: string) => boolean) | undefined) {
        this.#lines = lines;
        this.#raw = raw;
        this.#check = check;
        // Text lines only mark the innermost block non-empty, so a run of them is one step.
        const next: number[] = new Array(lines.length + 1).fill(lines.length);
        for (let i = lines.length - 1; i >= 0; i--) next[i] = lines[i]!.kind === "text" ? next[i + 1]! : i;
        this.#nextFence = next;
        const written: boolean[] = new Array(lines.length + 1).fill(false);
        for (let i = lines.length - 1; i >= 0; i--) { const line = lines[i]!; written[i] = line.kind === "text" && (line.blank !== true || written[i + 1]!); }
        this.#writtenRun = written;
    }

    solve(): { result: Result; cost: Cost } | null {
        const root = this.#summary(0, null, FRESH);
        if (root.length === 0) return null;
        const result: Result = { ends: new Map(), surplus: [], quotations: [], splits: [], repairs: [] };
        this.#replay(root[0]!, null, -1, result);
        return { result, cost: root[0]!.cost };
    }

    // Records what one entry's reading does, following it to the end of its block.
    #replay(entry: Entry, context: Context | null, opener: number, result: Result): void {
        let frame = context;
        let open = opener;
        for (let current: Entry | null = entry; current !== null;) {
            const { move, via }: Entry = current;
            for (const effect of move.effects) {
                if (effect.kind === "quotation") result.quotations.push(effect.line);
                else if (effect.kind === "surplus") result.surplus.push(effect.line);
                else if (effect.kind === "split") result.splits.push(effect.line);
                else result.repairs.push(effect.line);
            }
            if (move.kind === "end") return;
            if (move.kind === "stay") {
                if (move.into === null) result.ends.set(open, move.record!);
                if (move.into !== undefined) { frame = move.into; open = move.opener ?? -1; }
                current = this.#summary(move.next, frame, move.flags)[via[0]!]!;
                continue;
            }
            const child = this.#summary(at(move.line + 1), move.child, FRESH)[via[0]!]!;
            this.#replay(child, move.child, move.line, result);
            current = this.#summary(child.end, frame, move.flags)[via[1]!]!;
        }
    }

    #key(position: number, context: Context | null, flags: Flags): string {
        return `${position}|${context === null ? "" : `${context.kind}${context.character}${context.width}${context.bareOpened ? "b" : ""}${context.top ? "t" : ""}${context.quoted ? "q" : ""}${context.bodiless ? "n" : ""}${context.terminal ? "k" : ""}${context.runtime === undefined ? "" : `r${context.opener}`}${context.name}`}|${flags.empty ? "e" : ""}${flags.holds ? "h" : ""}${flags.written ? "w" : ""}`;
    }

    // Summaries depend only on summaries at later positions. They are evaluated on an explicit work stack, so
    // an input's length is bounded by the step limit, not by the call stack.
    #summary(position: number, context: Context | null, flags: Flags): Summary {
        const key = this.#key(position, context, flags);
        const known = this.#memo.get(key);
        if (known !== undefined) return known;
        const pending: Frame[] = [{ key, position, context, flags, moves: null, move: 0, entry: 0 }];
        while (pending.length > 0) {
            const frame = pending.at(-1)!;
            const needed = this.#needed(frame);
            if (needed !== null) { pending.push(needed); continue; }
            this.#memo.set(frame.key, this.#compose(frame));
            pending.pop();
        }
        return this.#memo.get(key)!;
    }

    // The first summary this frame still needs, advancing its cursor past the ones already known.
    #needed(frame: Frame): Frame | null {
        frame.moves ??= this.#framed(frame.position, frame.context, frame.flags);
        for (; frame.move < frame.moves.length; frame.move++, frame.entry = 0) {
            const move = frame.moves[frame.move]!;
            if (move.kind === "end") continue;
            if (move.kind === "stay") {
                const missing = this.#missing(move.next, move.into === undefined ? frame.context : move.into, move.flags);
                if (missing !== null) return missing;
                continue;
            }
            const start = at(move.line + 1);
            const missing = this.#missing(start, move.child, FRESH);
            if (missing !== null) return missing;
            const child = this.#memo.get(this.#key(start, move.child, FRESH))!;
            for (; frame.entry < child.length; frame.entry++) {
                const rest = this.#missing(child[frame.entry]!.end, frame.context, move.flags);
                if (rest !== null) return rest;
            }
        }
        return null;
    }

    #missing(position: number, context: Context | null, flags: Flags): Frame | null {
        const key = this.#key(position, context, flags);
        return this.#memo.has(key) ? null : { key, position, context, flags, moves: null, move: 0, entry: 0 };
    }

    #compose(frame: Frame): Summary {
        const { context } = frame;
        const known = (position: number, at: Context | null, flags: Flags): Summary => this.#memo.get(this.#key(position, at, flags))!;
        const best = new Map<number, Entry>();
        const offer = (entry: Entry): void => {
            const held = best.get(entry.end);
            if (held === undefined || less(entry.cost, held.cost)) best.set(entry.end, entry);
        };
        frame.moves!.forEach((move, m) => {
            if (move.kind === "end") { offer({ end: move.end, cost: move.cost, key: [m], move, via: [] }); return; }
            if (move.kind === "stay") {
                known(move.next, move.into === undefined ? context : move.into, move.flags).forEach((rest, j) =>
                    offer({ end: rest.end, cost: add(move.cost, rest.cost), key: [m, j], move, via: [j] }));
                return;
            }
            known(at(move.line + 1), move.child, FRESH).forEach((child, a) =>
                known(child.end, context, move.flags).forEach((rest, b) =>
                    offer({ end: rest.end, cost: add(add(move.cost, child.cost), rest.cost), key: [m, a, b], move, via: [a, b] })));
        });
        return [...best.values()].toSorted((x, y) => {
            for (let k = 0; k < Math.min(x.key.length, y.key.length); k++) if (x.key[k] !== y.key[k]) return x.key[k]! - y.key[k]!;
            return x.key.length - y.key.length;
        });
    }

    // A body under an operation that takes none is ignored with an advisory ({§matcher-body-redirect}); reading
    // one there costs a repair, so the fence the author wrote is that operation's closer where it can be.
    // A top-level block opens and ends within the root frame: the root needs only the cost to the end of the
    // input, so the frame of an open top-level block has one entry, not one per place the block could end.
    #framed(position: number, context: Context | null, flags: Flags): Move[] {
        return [...this.#moves(position, context, flags)].map((move): Move => {
            if (context === null && move.kind === "child") return { kind: "stay", cost: move.cost, effects: move.effects, next: move.start ?? at(move.line + 1), flags: FRESH, into: move.child, opener: move.line };
            if (context?.top && move.kind === "end") return { kind: "stay", cost: context.bodiless && flags.written || !this.#wellFormed(context, move.record) ? add(move.cost, REPAIR) : move.cost, effects: move.effects, next: move.end, flags: FRESH, into: null, record: move.record };
            return move;
        });
    }

    // An executor heading whose runtime can judge its body carries the runtime and its opening line.
    #judged(line: number): { runtime?: string; opener?: number } {
        const runtime = (this.#lines[line] as { runtime?: string | null }).runtime;
        return this.#check === undefined || runtime === null || runtime === undefined ? {} : { runtime, opener: line };
    }

    // A body that is not well-formed in its runtime's media type costs a repair ({§pairing-objective}); the
    // trailing aside is the writer's, not the body's ({§mcp-trailing-aside}).
    #wellFormed(context: Context, record: End | undefined): boolean {
        if (context.runtime === undefined || context.opener === undefined || record === undefined) return true;
        const last = record.kind === "end" ? this.#raw.length - 1 : record.line - 1;
        const key = `${context.opener}:${last}`;
        const known = this.#verdicts.get(key);
        if (known !== undefined) return known;
        const body = this.#raw.slice(context.opener + 1, last + 1).join("\n").replace(/(?:\s*<!--[\s\S]*?-->)+\s*$/u, "");
        const verdict = body.trim() === "" || this.#check!(context.runtime, body);
        this.#verdicts.set(key, verdict);
        return verdict;
    }

    #closable(context: Context, flags: Flags, character: FenceCharacter, width: number): boolean {
        return context.kind !== "naked" && context.character === character && width >= context.width && !(context.bareOpened && flags.empty && !(context.kind === "quotation" && context.top));
    }

    // The alternatives at one position, in preference order.
    *#moves(position: number, context: Context | null, flags: Flags): Generator<Move> {
        const i = position >> 1;
        const heading = (position & 1) === 1;
        const marked: Flags = { ...flags, empty: false, written: true };
        if (i === this.#lines.length) { yield* this.#atEnd(context, flags); return; }
        const line = this.#lines[i]!;
        if (line.kind === "text") {
            yield { kind: "stay", cost: ZERO, effects: [], next: at(this.#nextFence[i]!), flags: { ...flags, empty: false, written: flags.written || this.#writtenRun[i]! } };
            return;
        }
        if (heading) {
            const width = line.kind === "closeThenHeading" ? line.headingWidth : (line as { width: number }).width;
            yield* this.#heading(i, width, (line as { selfClosed: boolean }).selfClosed, context, flags);
            return;
        }
        switch (line.kind) {
            case "name":
                if (context === null) {
                    yield { kind: "child", cost: ZERO, effects: [], child: { kind: "naked", character: "`", width: Infinity, bareOpened: false, name: line.name, top: true, quoted: false }, line: i, flags };
                    return;
                }
                if (context.kind === "naked" && context.name === line.name && context.top) yield { kind: "end", cost: ZERO, effects: [], end: at(i + 1), record: { kind: "closer", line: i } };
                yield { kind: "stay", cost: ZERO, effects: [], next: at(i + 1), flags: marked };
                return;
            case "heading":
                yield* this.#heading(i, line.width, line.selfClosed, context, flags);
                return;
            case "closeThenHeading":
                // The run on this line closes the open block, then the rest of the line is the next heading.
                if (context !== null && this.#closable(context, flags, "`", line.width)) yield { kind: "end", cost: ZERO, effects: [], end: at(i, true), record: { kind: "closer", line: i } };
                else yield { kind: "stay", cost: ZERO, effects: [], next: at(i, true), flags };
                return;
            case "bare":
                yield* this.#bare(i, line, context, flags);
                return;
            case "info":
                yield* this.#info(i, line, context, flags);
                return;
        }
    }

    *#heading(i: number, width: number, selfClosed: boolean, context: Context | null, flags: Flags): Generator<Move> {
        const next = at(i + 1);
        if (context === null) {
            if (selfClosed) yield { kind: "stay", cost: ZERO, effects: [], next, flags };
            else yield { kind: "child", cost: ZERO, effects: [], child: { kind: "operation", character: "`", width, bareOpened: false, name: "", top: true, quoted: false, bodiless: (this.#lines[i] as { bodiless: boolean }).bodiless, terminal: (this.#lines[i] as { terminal?: boolean }).terminal === true, ...this.#judged(i) }, line: i, flags };
            return;
        }
        const example = (cost: Cost, held: Flags): Move => selfClosed
            ? { kind: "stay", cost, effects: [], next, flags: { ...held, empty: false, written: true } }
            : { kind: "child", cost, effects: [], child: { kind: "nested", character: "`", width, bareOpened: false, name: "", top: false, quoted: context.quoted, terminal: context.terminal }, line: i, flags: { ...held, empty: false, written: true } };
        const holding: Flags = { empty: false, holds: true, written: true };
        // {§terminal-kill}: a KILL body is the deliverable to its closer or the end of the input; a heading in it
        // is a literal example, or text, and never ends it.
        if (context.terminal) {
            yield example(ZERO, { ...flags, empty: false, written: true });
            yield { kind: "stay", cost: HIDE, effects: [], next, flags: { ...flags, empty: false, written: true } };
            return;
        }
        // {§quotation}: inside a quotation an operation is shown, never run — text, or a complete literal
        // example ({§balanced-fences}). Text first on a tie (CommonMark); the objective decides otherwise.
        if (context.quoted) {
            yield { kind: "stay", cost: HIDE, effects: [], next, flags: { ...flags, empty: false, written: true } };
            yield example(ZERO, flags);
            return;
        }
        // {§fence-heading-in-body}: in an operation's body a heading is a literal example only while the blocks
        // holding it end at real closers; otherwise it starts the next statement and the interrupted block takes a
        // supplied closer — a repair, placed as early as it applies. A naked block expects no closer: free.
        const interrupt = (cost: Cost): Move => ({ kind: "end", cost, effects: cost[0] > 0 ? [{ kind: "repair", line: i }] : [], end: at(i, true), record: { kind: "before", line: i } });
        // {§naked-operation}: a naked body runs to the next heading; it expects no closer, so ending there is free.
        if (context.kind === "naked") {
            if (!flags.holds) yield interrupt(ZERO);
            yield example(HIDE, holding);
            return;
        }
        // A literal example, or a heading narrower than its enclosing block read as content there (CommonMark),
        // names an operation that will not run: either costs a hidden operation.
        if (!flags.holds) yield interrupt(SUPPLY);
        yield example(HIDE, holding);
        if (context.character === "`" && width < context.width) yield { kind: "stay", cost: HIDE, effects: [], next, flags: holding };
    }

    *#bare(i: number, line: Extract<Line, { kind: "bare" }>, context: Context | null, flags: Flags): Generator<Move> {
        const { character, width } = line;
        const next = at(i + 1);
        const marked: Flags = { ...flags, empty: false, written: true };
        if (context === null && line.split !== undefined) {
            // {§forgotten-tag}: at the top level the fence and the heading under it are one opener.
            const { split } = line;
            const effects: Effect[] = [{ kind: "split", line: i }];
            if (split.selfClosed) yield { kind: "stay", cost: ZERO, effects, next: at(i + 2), flags };
            else yield { kind: "child", cost: ZERO, effects, child: { kind: "operation", character: "`", width, bareOpened: false, name: "", top: true, quoted: false, bodiless: split.bodiless, terminal: split.terminal, ...(split.runtime === null || this.#check === undefined ? {} : { runtime: split.runtime, opener: i + 1 }) }, line: i, start: at(i + 2), flags };
            return;
        }
        if (context === null) {
            // {§quotation}: the closer of a heading written mid-line in prose, which opened nothing, is an orphan
            // and quotes nothing.
            if (line.underFence && character === "`") { yield { kind: "stay", cost: ZERO, effects: [{ kind: "surplus", line: i }], next, flags }; return; }
            yield { kind: "child", cost: ZERO, effects: [{ kind: "quotation", line: i }], child: { kind: "quotation", character, width, bareOpened: true, name: "", top: true, quoted: true }, line: i, flags };
            yield { kind: "stay", cost: REPAIR, effects: [{ kind: "surplus", line: i }], next, flags };
            return;
        }
        const nest: Move = { kind: "child", cost: ZERO, effects: [], child: { kind: "nested", character, width, bareOpened: true, name: "", top: false, quoted: context.quoted, terminal: context.terminal }, line: i, flags: marked };
        const close: Move | null = this.#closable(context, flags, character, width) ? { kind: "end", cost: ZERO, effects: [], end: next, record: { kind: "closer", line: i } } : null;
        // Disambiguation filter: inside a quotation or a nested block the first valid closer closes, as in
        // CommonMark 0.31.2 §4.5.
        if (close !== null && (context.kind === "quotation" || !context.top)) { yield close; return; }
        if (context.kind === "quotation") {
            // Any other fence in a quotation opens a nested block, or is text.
            yield nest;
            yield { kind: "stay", cost: DEMOTE, effects: [], next, flags: marked };
            return;
        }
        // {§closer-fallback} as a repair: a same-character fence narrower than the top-level block it ends is the
        // closer the author meant, at a cost of one.
        if (context.top && context.kind !== "naked" && context.character === character && width < context.width && !(context.bareOpened && flags.empty)) {
            yield { kind: "end", cost: REPAIR, effects: [{ kind: "repair", line: i }], end: next, record: { kind: "closer", line: i } };
        }
        // {§balanced-fences}: nest, then close — the nesting preference that keeps a body whole.
        yield nest;
        if (close !== null) yield close;
        // A narrower or other fence is content (CommonMark); a closable one read as text is a surplus fence.
        if (context.character !== character || width < context.width || context.kind === "naked") yield { kind: "stay", cost: DEMOTE, effects: [], next, flags: marked };
        else yield { kind: "stay", cost: REPAIR, effects: [{ kind: "surplus", line: i }], next, flags: marked };
    }

    *#info(i: number, line: Extract<Line, { kind: "info" }>, context: Context | null, flags: Flags): Generator<Move> {
        const next = at(i + 1);
        if (context === null) {
            yield { kind: "child", cost: ZERO, effects: [{ kind: "quotation", line: i }], child: { kind: "quotation", character: line.character, width: line.width, bareOpened: false, name: "", top: true, quoted: true }, line: i, flags };
            return;
        }
        const push: Move = { kind: "child", cost: ZERO, effects: [], child: { kind: "nested", character: line.character, width: line.width, bareOpened: false, name: "", top: false, quoted: context.quoted, terminal: context.terminal }, line: i, flags: { ...flags, empty: false, written: true } };
        // Outside a quotation a labeled fence is a code block the author declared; reading it as text ranks with a
        // hidden operation, so no reading ends a body early by discarding one.
        const text: Move = { kind: "stay", cost: context.quoted ? DEMOTE : HIDE, effects: [], next, flags: { ...flags, empty: false, written: true } };
        // A labeled fence opens a literal nested block, or is text — a demotion (inside a quotation, text first
        // on a tie, as CommonMark reads it).
        if (context.quoted) { yield text; yield push; return; }
        yield push;
        yield text;
    }

    // At the end of the input every open block takes a supplied closer; a naked block needs none. A block
    // opened by a bare fence must hold a line (an empty block is not a block), and a block holding a heading
    // as an example must have ended at a real closer.
    *#atEnd(context: Context | null, flags: Flags): Generator<Move> {
        const end = at(this.#lines.length);
        if (context === null) { yield { kind: "end", cost: ZERO, effects: [], end, record: { kind: "end" } }; return; }
        if ((context.bareOpened && flags.empty) || flags.holds) return;
        if (context.kind === "naked") yield { kind: "end", cost: ZERO, effects: [], end, record: { kind: "end" } };
        else yield { kind: "end", cost: SUPPLY, effects: [{ kind: "repair", line: this.#lines.length }], end, record: { kind: "end" } };
    }
}
