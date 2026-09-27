// {§balanced-fences} matrix: the cells a model writes, generated, each with the reading the
// metacontract requires (a complete nested interpretation wins; only irreconcilable shapes fall back).
// {§fence-pairing}: an operation example quoted in a body of its own width reads as the body closing and the
// example running, except in a KILL, whose body is the deliverable ({§terminal-kill}).
// {§unclosed-mutation-yields}: a native example at an EDIT body's own width runs, closed or not; an example
// inside an EDIT is written with the wider outer fence ({§operation-fences}).
export type Cell = {
    readonly name: string;
    readonly text: string;
    readonly op: string;
    readonly body: string;
    readonly following: readonly string[];
    readonly ambiguous?: string;
};

const HEAD: Readonly<Record<string, string>> = {
    KILL: "KILL", SEND: "SEND", NOTE: "NOTE", BARE: "BARE",
    EDIT: "EDIT (docs/guide.md) <1,-1>", WORK: "WORK (worker://helper)",
};
const fence = (width: number, character = "`") => character.repeat(width);

type Inner = {
    readonly name: string;
    readonly body: (outer: number) => string | null;
    // The reading at the example's own width outside a KILL: the body before it, then what runs.
    readonly sameWidth?: { readonly body: string; readonly following: readonly string[] };
    // The reading at the example's own width inside an EDIT ({§unclosed-mutation-yields}).
    readonly mutationSameWidth?: { readonly body: string; readonly following: readonly string[] };
};
const INNERS: readonly Inner[] = [
    { name: "plain text", body: () => "All tests pass.\nNothing else changed." },
    { name: "bare block", body: () => `Result:\n${fence(3)}\nok 12 tests\n${fence(3)}\nDone.` },
    { name: "two bare blocks", body: () => `Before:\n${fence(3)}\nold()\n${fence(3)}\nAfter:\n${fence(3)}\nnew()\n${fence(3)}` },
    { name: "labeled block", body: () => `Patch:\n${fence(3)}python\nx = 1\n${fence(3)}\nApplied.` },
    { name: "labeled then bare", body: () => `${fence(3)}diff\n-a\n+b\n${fence(3)}\nOutput:\n${fence(3)}\n1 passed\n${fence(3)}` },
    { name: "bare block at body end", body: () => `Traceback:\n${fence(3)}\nValueError: bad\n${fence(3)}` },
    { name: "bare block at body start", body: () => `${fence(3)}\n$ pytest\n${fence(3)}\nall green` },
    { name: "tilde block", body: () => `Log:\n~~~\nline one\n~~~\nEnd.` },
    { name: "four-wide inner", body: () => `Nested:\n${fence(4)}\nouter example\n${fence(4)}\nEnd.` },
    { name: "quoted operation example", body: () => `Use this form:\n${fence(3)}\n${fence(3)}READ (a.md) <1,5>\n${fence(3)}\n${fence(3)}\nThat is all.`, sameWidth: { body: "Use this form:", following: ["READ"] } },
    { name: "labeled quoted operation", body: () => `Example:\n${fence(3)}READ (a.md) <1,5>\n${fence(3)}\nEnd.`, mutationSameWidth: { body: "Example:", following: ["READ"] } },
    { name: "markdown document", body: () => `# Guide\n\nRun:\n\n${fence(3)}sh\nnpm test\n${fence(3)}\n\nThen:\n\n${fence(3)}\nnpm run build\n${fence(3)}\n` },
];

type Tail = { readonly name: string; readonly text: string; readonly following: readonly string[]; readonly ambiguous?: string };
const TAILS: readonly Tail[] = [
    { name: "end of emission", text: "", following: [] },
    { name: "next operation", text: `\n\n${fence(3)}READ (a.md) <1,5>\n${fence(3)}`, following: ["READ"] },
    { name: "next operation compact", text: `\n${fence(3)}FIND (src/**) /TODO/${fence(3)}`, following: ["FIND"] },
    { name: "trailing prose", text: "\n\nThat should do it.", following: [] },
];

export const cells = (): Cell[] => {
    const out: Cell[] = [];
    for (const [op, head] of Object.entries(HEAD)) for (const width of [3, 4, 5]) for (const inner of INNERS) for (const tail of TAILS) {
        const body = inner.body(width);
        if (body === null) continue;
        const text = `${fence(width)}${head}\n${body}\n${fence(width)}${tail.text}`;
        const runs = width === 3 && op === "EDIT" && inner.mutationSameWidth !== undefined ? inner.mutationSameWidth
            : inner.sameWidth !== undefined && width === 3 && op !== "KILL" ? inner.sameWidth : null;
        // {§unclosed-mutation-yields} then {§quotation}: once the example runs, the EDIT's written closer is a stray
        // top-level fence that quotes the operation after it (shown, not run, with its advisory).
        const quoted = runs !== null && runs === inner.mutationSameWidth && tail.name === "next operation";
        out.push({ name: `${op} · outer ${width} · ${inner.name} · ${tail.name}`, text, op, body: runs?.body ?? body, following: [...runs?.following ?? [], ...(quoted ? [] : tail.following)], ...(tail.ambiguous ? { ambiguous: tail.ambiguous } : {}) });
    }
    return out;
};
