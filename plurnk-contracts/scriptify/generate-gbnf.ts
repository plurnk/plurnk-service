// Generates the Gemma- and Qwen-template llama.cpp rails for canonical
// fenced turns from one shared operation grammar.
// ANTLR remains the accepted-language authority; this deliberately narrower
// grammar makes useful, parseable local-model output likely and bounded.
import { mkdir, writeFile } from "node:fs/promises";

export type GItem =
    | { kind: "lit"; text: string }
    | { kind: "cls"; ranges: Array<[number, number]>; negate: boolean }
    | { kind: "ref"; name: string }
    | { kind: "rep"; item: GItem; min: 0 | 1; max: number };
export type GSeq = GItem[];
export type GRule = GSeq[];
export type GModel = Map<string, GRule>;

const lit = (text: string): GItem => ({ kind: "lit", text });
const ref = (name: string): GItem => ({ kind: "ref", name });
const opt = (item: GItem): GItem => ({ kind: "rep", item, min: 0, max: 1 });
const star = (item: GItem): GItem => ({ kind: "rep", item, min: 0, max: Infinity });
const plus = (item: GItem): GItem => ({ kind: "rep", item, min: 1, max: Infinity });

const R = (a: string, b: string): [number, number] => [a.codePointAt(0)!, b.codePointAt(0)!];
const C = (chars: string): Array<[number, number]> => [...new Set(chars)].map((character) => R(character, character));
const cls = (ranges: Array<[number, number]>, negate = false): GItem => ({ kind: "cls", ranges, negate });

const DIGIT = cls([R("0", "9")]);
const BASE62 = cls([R("0", "9"), R("A", "Z"), R("a", "z")]);
const WS = cls(C(" \t\r\n"));
const CONTROL_RANGES: Array<[number, number]> = [[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x7F]];
const LINE_TERMINATORS: Array<[number, number]> = [[0x0A, 0x0A], [0x0D, 0x0D]];
const FENCE_LENGTHS = [3, 4] as const;

const bodyOther = (excluded: string, singleLine = false): GItem =>
    cls([...CONTROL_RANGES, ...(singleLine ? LINE_TERMINATORS : []), ...C(excluded)], true);

// Complement automaton for a finite set of forbidden literals. State is the
// longest consumed suffix that is also a proper prefix of a forbidden literal.
// Completing a literal has no transition. initialPrefix supplies already-consumed
// context, such as the header newline before the first body character.
const forbidLiterals = (
    model: GModel,
    name: string,
    literals: string[],
    singleLine = false,
    initialPrefix = "",
): void => {
    if (literals.length === 0 || literals.some((literal) => literal.length === 0)) {
        throw new Error("forbidLiterals requires non-empty literals");
    }
    const states = [""];
    for (const literal of literals) {
        for (let length = 1; length < literal.length; length++) {
            const prefix = literal.slice(0, length);
            if (!states.includes(prefix)) states.push(prefix);
        }
    }
    const stateIndex = new Map(states.map((state, index) => [state, index]));
    const ruleOf = (state: string): string => `${name}-b${stateIndex.get(state)!}`;
    const significant = [...new Set(literals.flatMap((literal) => [...literal]))];
    const statesByLength = states.toSorted((a, b) => b.length - a.length);
    const nextState = (candidate: string): string => statesByLength.find((state) => candidate.endsWith(state))!;

    for (const state of states) {
        const transitions = new Map<string, string[]>();
        for (const character of significant) {
            if (singleLine && (character === "\n" || character === "\r")) continue;
            const candidate = state + character;
            if (literals.some((literal) => candidate.endsWith(literal))) continue;
            const target = nextState(candidate);
            const characters = transitions.get(target) ?? [];
            characters.push(character);
            transitions.set(target, characters);
        }
        const alternatives: GRule = [...transitions].map(([target, characters]) => [
            characters.length === 1 ? lit(characters[0]) : cls(C(characters.join(""))),
            ref(ruleOf(target)),
        ]);
        alternatives.push([bodyOther(significant.join(""), singleLine), ref(ruleOf(""))]);
        alternatives.push([]);
        model.set(ruleOf(state), alternatives);
    }
    const initial = model.get(ruleOf(initialPrefix));
    if (!initial) throw new Error(`forbidLiterals has no initial prefix ${JSON.stringify(initialPrefix)}`);
    model.set(`${name}-ne`, initial.filter((sequence) => sequence.length > 0));
};

const fencedSection = (
    model: GModel,
    name: string,
    headers: GRule,
    { body = "optional", matcher = false, terminal = false }: {
        body?: "none" | "optional" | "required";
        matcher?: boolean;
        terminal?: boolean;
    } = {},
): void => {
    const headerName = `${name}-header`;
    model.set(headerName, headers.map((header) => [...header, opt(ref("annotation-slot"))]));
    model.set(name, FENCE_LENGTHS.flatMap((length): GRule => {
        const fence = "`".repeat(length);
        const open = [lit(fence), ref(headerName)];
        const close = lit(fence + (terminal ? "" : "\n"));
        return [
            ...(body === "required" ? [] : [[...open, opt(lit("\n")), opt(lit("\n")), close]]),
            ...(body === "none" ? [] : [[
                ...open, lit("\n"),
                ref(`${matcher ? "pattern" : "section"}-body-${length}-ne`),
                lit("\n"), close,
            ]]),
        ];
    }));
};

export const buildModel = (): GModel => {
    const model: GModel = new Map();
    // {§rail-heading-boundaries} — each body reserves its chosen closing fence,
    // including immediately after the header newline of an empty block.
    for (const length of FENCE_LENGTHS) {
        const closer = `\n${"`".repeat(length)}`;
        forbidLiterals(model, `section-body-${length}`, [closer], false, "\n");
        forbidLiterals(model, `pattern-body-${length}`, [closer, "\n:"], true, "\n");
    }
    forbidLiterals(model, "annotation-body", ["-->"], true);

    const target = [ref("target-slot")];
    const line = [ref("line-slot")];
    const targetScope = (op: string, lineRule = "line-slot"): GSeq => [
        lit(op),
        target[0],
        opt(ref(lineRule)),
    ];
    const transfer = (op: "COPY" | "MOVE"): GSeq => [
        lit(op),
        target[0],
        opt(ref("text-line-slot")),
        target[0],
        opt(ref("text-line-slot")),
    ];

    fencedSection(model, "find", [targetScope("FIND")], { matcher: true });
    fencedSection(model, "read", [targetScope("READ", "text-line-slot")], { matcher: true });
    fencedSection(model, "edit", [targetScope("EDIT", "text-line-slot")]);
    fencedSection(model, "copy", [transfer("COPY")], { body: "none" });
    fencedSection(model, "move", [transfer("MOVE")], { body: "none" });
    // {§exec-executor-slot} — runtime and MCP service names lower to EXEC.
    fencedSection(model, "exec", [[
        ref("exec-name"),
        opt(ref("exec-program")),
        opt(line[0]),
    ]]);
    fencedSection(model, "bare-inline", [[lit("BARE")]], { body: "required" });
    fencedSection(model, "bare-resource", [[lit("BARE"), target[0]]]);
    model.set("bare", [[ref("bare-inline")], [ref("bare-resource")]]);
    fencedSection(model, "work", [[lit("WORK"), target[0]]], { body: "required" });
    fencedSection(model, "fork", [[lit("FORK"), target[0]]], { body: "required" });
    // {§kill-scope} — a KILL names its target, may scope lines of a log body or an entry, and
    // may select rows with a one-line matcher body.
    fencedSection(model, "kill", [[lit("KILL"), target[0], opt(ref("text-line-slot"))]], { matcher: true });

    // SEND messages a recipient URL, or the user; lifecycle operations are separate.
    fencedSection(model, "send-mid", [
        [lit("SEND"), ref("recipient-slot"), opt(ref("park-slot"))],
        [lit("SEND")],
    ]);

    // {§turn-disposition} — native lifecycle operations carry no recipient.
    const final = (name: string, label: string, park: boolean): void => {
        fencedSection(model, name, [[
            lit(label),
            ...(park ? [opt(ref("park-slot"))] : []),
        ]], { body: "required", terminal: true });
    };
    final("send-102", "NEXT", false);
    final("send-200", "DONE", false);
    final("send-202", "WAIT", true);
    final("send-499", "FAIL", false);
    model.set("send-final-any", [[ref("send-102")], [ref("send-200")], [ref("send-202")], [ref("send-499")]]);
    model.set("send-final-first", [[ref("send-200")], [ref("send-202")], [ref("send-499")]]);

    model.set("op-statement", [
        [ref("find")], [ref("read")], [ref("edit")], [ref("copy")], [ref("move")],
        [ref("exec")], [ref("bare")], [ref("work")], [ref("fork")], [ref("kill")],
    ]);

    // {§gbnf-turn-shape} — NEXT needs work before it; other dispositions may stand
    // alone. Recursion imposes no ordinary-operation quota. {§disposition-ends-turn} — the
    // disposition's body is the turn's last sampled text: no statement follows it, so a rail
    // that keeps generating can only lengthen that body, never emit another operation.
    for (const name of ["tail-0", "tail-work"]) {
        model.set(name, [
            [ref("statement"), ref("block-sep"), ref("tail-work")],
            [ref(name === "tail-0" ? "send-final-first" : "send-final-any")],
        ]);
    }

    model.set("sep", [Array.from({ length: 7 }, () => opt(WS))]);
    model.set("blank-line", [[star(cls(C(" \t\r"))), lit("\n")]]);
    model.set("block-sep", [[star(ref("blank-line"))]]);
    const channelOpen = "<|channel>thought\n";
    const channelClose = "<channel|>";
    forbidLiterals(model, "rz-chan", [channelOpen, channelClose]);
    // {§gbnf-turn-shape} — the thought channel is never empty: the rail admits no
    // empty-channel exit, so a constrained gemma call always reasons before its turn.
    model.set("rz-chan-first", [[cls([[0x30, 0x39], [0x41, 0x5A], [0x61, 0x7A]])]]);
    model.set("channel", [[lit(channelOpen), ref("rz-chan-first"), ref("rz-chan-b0"), lit(channelClose)]]);
    const thinkOpen = "<think>\n";
    const thinkClose = "</think>";
    forbidLiterals(model, "rz-think", [thinkOpen, thinkClose]);
    // Qwen-style templates preserve their prompt-supplied opener in the raw
    // response. GBNF begins with the first sampled token, so this profile owns
    // the reasoning body and closer. A separate response root composes the
    // opener back in for independent grading of provider evidence.
    // {§gbnf-turn-shape} — the same rule as the gemma channel: no empty-thought exit.
    model.set("rz-think-first", [[cls([[0x30, 0x39], [0x41, 0x5A], [0x61, 0x7A]])]]);
    model.set("qwen-tail", [[ref("rz-think-first"), ref("rz-think-b0"), lit(thinkClose)]]);
    model.set("turn", [[ref("tail-0")]]);
    model.set("root-gemma", [[ref("channel"), ref("sep"), ref("turn")]]);
    model.set("root-qwen", [[ref("qwen-tail"), ref("sep"), ref("turn")]]);
    model.set("root-qwen-response", [[lit(thinkOpen), ref("root-qwen")]]);

    model.set("statement", [[ref("op-statement")], [ref("send-mid")]]);
    model.set("send-statement", [[ref("send-mid")], [ref("send-final-any")]]);

    model.set("target-slot", [[lit(" "), ref("target"), star(ref("metadata-slot"))]]);
    model.set("recipient-slot", [[lit(" ("), ref("scheme"), lit("://"), ref("target-inner"), lit(")"), star(ref("metadata-slot"))]]);
    model.set("scheme", [[cls([[0x61, 0x7A]]), star(cls([[0x61, 0x7A], [0x30, 0x39], [0x2B, 0x2B], [0x2D, 0x2D], [0x2E, 0x2E]]))]]);
    // An executor name is a runtime tag: scheme-name characters, `+` included (#105).
    model.set("executor-name", [[cls([R("a", "z")]), star(cls([R("0", "9"), R("A", "Z"), R("a", "z"), ...C("_.+-")]))]]);
    model.set("exec-name", [[lit("EXEC")], [ref("executor-name")]]);
    // The program path with its metadata, or `{cwd=…}` metadata alone.
    model.set("exec-program", [[ref("target-slot")], [ref("metadata-slot"), star(ref("metadata-slot"))]]);
    model.set("metadata-slot", [[lit(" "), ref("metadata-block")]]);
    model.set("metadata-block", [[lit("{"), star(ref("metadata-inner")), lit("}")]]);
    model.set("metadata-inner", [
        [bodyOther('{}"', true)],
        [ref("metadata-block")],
        [lit('"'), star(ref("metadata-string")), lit('"')],
    ]);
    model.set("metadata-string", [
        [bodyOther('"\\', true)],
        [lit("\\"), bodyOther("", true)],
    ]);
    model.set("line-slot", [[lit(" "), ref("line")]]);
    model.set("text-line-slot", [[lit(" "), ref("text-line")]]);
    model.set("park-slot", [[lit(" "), ref("park")]]);
    model.set("annotation-slot", [[lit(" <!-- "), ref("annotation-body-ne"), lit(" -->")]]);

    model.set("target", [[lit("("), ref("target-inner"), lit(")")]]);
    model.set("target-inner", [[plus(ref("target-atom"))]]);
    model.set("target-atom", [
        [cls([...CONTROL_RANGES, ...C("\\()<\r\n")], true)],
        [ref("target-escape")],
    ]);
    model.set("target-escape", [[lit("\\\\")], [lit("\\(")], [lit("\\)")]]);
    model.set("line", [[lit("<"), ref("int"), star(ref("line-rest")), lit(">")]]);
    model.set("line-rest", [[lit(","), ref("int")]]);
    model.set("text-line", [[lit("<"), ref("text-coordinate"), star(ref("text-line-rest")), lit(">")]]);
    model.set("text-line-rest", [[lit(","), ref("text-coordinate")]]);
    model.set("text-coordinate", [[ref("int")], [ref("line-anchor")]]);
    model.set("line-anchor", [[lit("@"), BASE62, BASE62, BASE62, BASE62, BASE62]]);
    model.set("int", [[opt(lit("-")), plus(DIGIT), opt(ref("frac"))]]);
    model.set("frac", [[lit("."), plus(DIGIT)]]);
    model.set("park", [[lit("<"), ref("park-t"), opt(ref("park-poll")), lit(">")]]);
    model.set("park-t", [[lit("-1")], [plus(DIGIT)]]);
    model.set("park-poll", [[lit(","), plus(DIGIT)]]);
    return model;
};

const escapeLiteral = (text: string): string => text
    .replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

const escapeClassChar = (codePoint: number): string => {
    if (codePoint === 0x0A) return "\\n";
    if (codePoint === 0x0D) return "\\r";
    if (codePoint === 0x09) return "\\t";
    if (codePoint < 0x20 || codePoint === 0x7F) return `\\x${codePoint.toString(16).padStart(2, "0").toUpperCase()}`;
    const character = String.fromCodePoint(codePoint);
    if (character === "\\" || character === "]" || character === "[") return `\\${character}`;
    return character;
};

const serializeClass = (ranges: Array<[number, number]>, negate: boolean): string => {
    const sorted = ranges.toSorted((a, b) => Number(a[0] === a[1] && a[0] === 0x2D) - Number(b[0] === b[1] && b[0] === 0x2D));
    const parts = sorted.map(([start, end]) => {
        if (start === end) return start === 0x2D ? "-" : escapeClassChar(start);
        return `${escapeClassChar(start)}-${escapeClassChar(end)}`;
    });
    return `[${negate ? "^" : ""}${parts.join("")}]`;
};

const serializeItem = (item: GItem): string => {
    switch (item.kind) {
        case "lit": return `"${escapeLiteral(item.text)}"`;
        case "cls": return serializeClass(item.ranges, item.negate);
        case "ref": return item.name;
        case "rep": {
            const suffix = item.max === 1 ? "?" : item.min === 0 ? "*" : "+";
            return serializeItem(item.item) + suffix;
        }
    }
};

const reachableFrom = (model: GModel, rootName: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (name: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        const alternatives = model.get(name);
        if (!alternatives) return;
        const walk = (item: GItem): void => {
            if (item.kind === "ref") visit(item.name);
            else if (item.kind === "rep") walk(item.item);
        };
        for (const sequence of alternatives) for (const item of sequence) walk(item);
    };
    visit(rootName);
    return seen;
};

export const serializeGbnf = (model: GModel, rootName: string): string => {
    const responseRoot = rootName === "root-gemma"
        ? "root-gemma"
        : rootName === "root-qwen"
            ? "root-qwen-response"
            : undefined;
    const reachable = reachableFrom(model, responseRoot ?? rootName);
    const lines = [
        "# @generated by scriptify/generate-gbnf.ts — do not edit; run `npm run build:gbnf`.",
        ...(responseRoot === undefined ? [] : [`# @plurnk-response-root ${responseRoot}`]),
        `root ::= ${rootName}`,
    ];
    for (const [name, alternatives] of model) {
        if (!reachable.has(name)) continue;
        const hasEpsilon = alternatives.some((sequence) => sequence.length === 0);
        const bodies = alternatives
            .filter((sequence) => sequence.length > 0)
            .map((sequence) => sequence.map(serializeItem).join(" "));
        lines.push(hasEpsilon
            ? `${name} ::= (${bodies.join(" | ")})?`
            : `${name} ::= ${bodies.join(" | ")}`);
    }
    return `${lines.join("\n")}\n`;
};

if (import.meta.main) {
    await mkdir("dist", { recursive: true });
    const model = buildModel();
    await Promise.all([
        writeFile("dist/plurnk.gemma.gbnf", serializeGbnf(model, "root-gemma")),
        writeFile("dist/plurnk.qwen.gbnf", serializeGbnf(model, "root-qwen")),
    ]);
    process.stderr.write("Generated dist/plurnk.{gemma,qwen}.gbnf from one shared executable-fence grammar\n");
}
