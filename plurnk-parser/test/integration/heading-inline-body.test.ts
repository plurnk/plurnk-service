// {§heading-inline-body} — every operation, every kind of heading text, every place it is written: the operation
// is never lost, no text is dropped silently, and the reading follows the shape table and {§terminal-kill}.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const TEXTS = { word: "then more", sigil: "/x/", object: '{"a": 1}' } as const;
type Kind = keyof typeof TEXTS;
const fence = "```";
const PLACES = {
    open: (heading: string, text: string) => `${fence}${heading} ${text}\n${fence}`,
    after: (heading: string, text: string) => `${fence}${heading}${fence} ${text}`,
    inside: (heading: string, text: string) => `${fence}${heading} ${text}${fence}`,
    below: (heading: string, text: string) => `${fence}${heading}\n${text}\n${fence}`,
} as const;

type Reading = { matcher?: string; body?: string; metadata?: string[]; advisory?: string };
type Read = (kind: Kind, text: string, inline: boolean) => Reading;

const inlineBody = (name: string) => `\`${name}\` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line.`;
// {§diagnostic-observation} — every source here opens on line 1: unread text stands beside the heading or on line 2.
const ignored = (name: string, inline: boolean) => `${name} takes no body; ${inline ? "the text after its heading on line 1" : "line 2"} was not used.`;
const objectMatcher = "`{…}` was read as the matcher.";
const optionObject = (name: string) => `\`${name}\` took a bare option object; the taught form is \`[{…}]\`.`;
const PATTERN = ' [{"pattern": "/p/"}]';

// The heading line is the matcher's; beneath it, only one sigil line lifts and anything else is ignored.
const matcherOp = (name: string): Read => (kind, text, inline) => inline
    ? { matcher: text, ...(kind === "object" ? { advisory: objectMatcher } : {}) }
    : kind === "sigil" ? { matcher: text } : { advisory: ignored(name, false) };
// Heading text is the body's first line, named; text beneath is the body.
const bodied = (name: string): Read => (_kind, text, inline) => ({ body: text, ...(inline ? { advisory: inlineBody(name) } : {}) });
// One JSON object on the heading line is the option block; any other heading text is the body.
const optioned = (name: string, empty: string | undefined): Read => (kind, text, inline) => inline && kind === "object"
    ? { metadata: [text], advisory: optionObject(name), ...(empty === undefined ? {} : { body: empty }) }
    : bodied(name)(kind, text, inline);

const SHAPES: readonly (readonly [heading: string, op: string, read: Read])[] = [
    ["FIND (a.md)", "FIND", matcherOp("FIND")],
    ["READ (a.md)", "READ", matcherOp("READ")],
    ["KILL (a.md)", "KILL", matcherOp("This KILL")],
    ["KILL (log:///1/2/3)", "KILL", (kind, text, inline) => inline ? matcherOp("KILL")(kind, text, inline) : { body: text }],
    ["EDIT (a.md) <1>", "EDIT", (kind, text, inline) => inline && kind === "sigil" ? { matcher: text } : bodied("EDIT")(kind, text, inline)],
    ["COPY (a.md) (b.md)", "COPY", (_kind, _text, inline) => ({ advisory: ignored("COPY", inline) })],
    ["MOVE (a.md) (b.md)", "MOVE", (_kind, _text, inline) => ({ advisory: ignored("MOVE", inline) })],
    ["SEND", "SEND", optioned("SEND", undefined)],
    ["SEND (worker://x)", "SEND", optioned("SEND", undefined)],
    // BARE, WORK and FORK take an option block only after their target.
    ["BARE", "BARE", bodied("BARE")],
    ["BARE (p.md)", "BARE", optioned("BARE", "")],
    ["WORK", "WORK", bodied("WORK")],
    ["WORK (worker://x)", "WORK", optioned("WORK", "")],
    ["FORK", "FORK", bodied("FORK")],
    ["FORK (worker://x)", "FORK", optioned("FORK", "")],
    ["sh", "sh", optioned("sh", undefined)],
    ["NOTE", "NOTE", bodied("NOTE")],
    ["WAIT", "WAIT", bodied("WAIT")],
    ["KILL", "KILL", bodied("KILL")],
    // Beside an option block's pattern the heading text is not the matcher.
    [`FIND (a.md)${PATTERN}`, "FIND", (_kind, _text, inline) => ({ matcher: "/p/", advisory: ignored("FIND", inline) })],
    [`READ (a.md)${PATTERN}`, "READ", (_kind, _text, inline) => ({ matcher: "/p/", advisory: ignored("READ", inline) })],
    [`KILL (a.md)${PATTERN}`, "KILL", (_kind, _text, inline) => ({ matcher: "/p/", advisory: ignored("This KILL", inline) })],
    [`KILL (log:///1/2/3)${PATTERN}`, "KILL", (kind, text, inline) => ({ matcher: "/p/", ...bodied("KILL")(kind, text, inline) })],
    [`EDIT (a.md) <1>${PATTERN}`, "EDIT", (kind, text, inline) => ({ matcher: "/p/", ...bodied("EDIT")(kind, text, inline) })],
];

const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh"] });
const nameOf = (statement: object): string => "op" in statement ? String(statement.op) : String((statement as { runtime: string }).runtime);
const reading = (statement: Record<string, unknown>): Reading => {
    const body = statement.body as string | { raw: string } | null | undefined;
    const matcher = statement.matcher as { raw: string } | null | undefined;
    const metadata = statement.metadata as string[] | null | undefined;
    return {
        ...(matcher ? { matcher: matcher.raw } : {}),
        ...(body === null || body === undefined ? {} : { body: typeof body === "string" ? body : body.raw }),
        ...(metadata ? { metadata } : {}),
    };
};

for (const [heading, op, read] of SHAPES) {
    test(`{§heading-inline-body} ${heading}: heading text is read by the operation's shape, wherever it is written`, () => {
        for (const [kind, text] of Object.entries(TEXTS) as [Kind, string][]) {
            for (const [place, write] of Object.entries(PLACES)) {
                const source = write(heading, text);
                const label = `${place} ${kind}: ${source}`;
                const result = parse(source);
                assert.equal(result.unparsedTail, undefined, label);
                assert.deepEqual(result.items.filter((item) => item.kind === "error" && item.error.severity === "error").map((item) => item.kind === "error" && item.error.message), [], label);
                const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement as unknown as Record<string, unknown>] : []);
                assert.deepEqual(statements.map(nameOf), [op], `${label} — the operation is never lost`);
                const { advisory, ...expected } = read(kind, text, place !== "below");
                assert.deepEqual(reading(statements[0]!), expected, label);
                assert.deepEqual(result.items.flatMap((item) => item.kind === "error" ? [item.error.message] : []), advisory === undefined ? [] : [advisory], `${label} — a reading other than the canonical one is named once`);

                const tail = `\n\n${fence}READ (z.md)\n${fence}`;
                const followed = parse(`${source}${tail}`);
                const following = followed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
                if (heading === "KILL") {
                    assert.deepEqual(following.map(nameOf), ["KILL"], `${label} — the apparent operation is answer text`);
                    assert.equal(reading(following[0] as unknown as Record<string, unknown>).body, `${text}${place === "open" || place === "below" ? `\n${fence}` : ""}${tail}`, label);
                } else {
                    assert.deepEqual(following.map(nameOf), [op, "READ"], `${label} — the operation after it still runs`);
                }

                const canonical = PlurnkParser.stringify([statements[0] as never]);
                const again = parse(canonical);
                assert.deepEqual(again.items.filter((item) => item.kind === "error"), [], `${label} — the canonical form ${canonical} reads clean`);
                assert.deepEqual(again.items.flatMap((item) => item.kind === "statement" ? [reading(item.statement as unknown as Record<string, unknown>)] : []), [reading(statements[0]!)], `${label} — and reads the same`);
            }
        }
    });
}
