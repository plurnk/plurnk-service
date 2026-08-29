// Generates the Gemma- and Qwen-template llama.cpp rails for canonical
// lane-0 turns from one shared operation grammar.
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

const OPS = ["FIND", "READ", "EDIT", "COPY", "MOVE", "OPEN", "FOLD", "SEND", "EXEC", "BARE", "WORK", "FORK", "KILL"] as const;
const DIGIT = cls([R("0", "9")]);
const BASE62 = cls([R("0", "9"), R("A", "Z"), R("a", "z")]);
const WS = cls(C(" \t\r\n"));
const TAG_HEAD = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.")]);
const TAG_TAIL = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.+-")]);
const BRANCH_CHAR = cls([R("A", "Z"), R("a", "z"), R("0", "9"), ...C("_.-/")]);
const EXEC_HEAD = cls([R("a", "z")]);
const EXEC_TAIL = cls([R("a", "z"), R("0", "9"), ...C("_-")]);
const CONTROL_RANGES: Array<[number, number]> = [[0x00, 0x08], [0x0B, 0x0C], [0x0E, 0x1F], [0x7F, 0x7F]];
const LINE_TERMINATORS: Array<[number, number]> = [[0x0A, 0x0A], [0x0D, 0x0D]];

const bodyOther = (excluded: string, singleLine = false): GItem =>
    cls([...CONTROL_RANGES, ...(singleLine ? LINE_TERMINATORS : []), ...C(excluded)], true);

// Complement automaton for a finite set of forbidden literals. State is the
// longest consumed suffix that is also a proper prefix of a forbidden literal.
// Completing a literal has no transition. Heading prefixes are forbidden in
// section bodies so the explicit following heading is the unique boundary.
const forbidLiterals = (
    model: GModel,
    name: string,
    literals: string[],
    singleLine = false,
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
    model.set(`${name}-ne`, model.get(`${name}-b0`)!.filter((sequence) => sequence.length > 0));
};

const optionalBodySection = (
    model: GModel,
    name: string,
    header: GSeq,
    bodyRule: string,
): void => {
    const annotated = [...header, opt(ref("annotation-slot"))];
    model.set(name, [
        [...annotated, lit("\n")],
        [...annotated, lit("\n"), ref(`${bodyRule}-ne`), lit("\n")],
    ]);
};

const requiredBodySection = (
    model: GModel,
    name: string,
    header: GSeq,
    bodyRule = "section-body",
): void => {
    model.set(name, [[...header, opt(ref("annotation-slot")), lit("\n"), ref(`${bodyRule}-ne`), lit("\n")]]);
};

const emptySection = (model: GModel, name: string, header: GSeq): void => {
    model.set(name, [[...header, opt(ref("annotation-slot")), lit("\n")]]);
};

export const buildModel = (): GModel => {
    const model: GModel = new Map();
    // Reserve operation-heading stems rather than only their canonical lane-0
    // spellings. The rail can then force the `0` instead of swallowing a
    // wrong-lane pseudo-heading as literal body text. ANTLR remains the wider
    // language for intentional alternate-lane literals.
    const structuralHeadings = ["# PLAN", ...OPS.map((op) => `## ${op}`)];
    forbidLiterals(model, "section-body", structuralHeadings);
    forbidLiterals(model, "annotation-body", ["-->"], true);

    // Matcher bodies are single-line on the rail. `:` and `#` are excluded only
    // in first position: colon retains the existing typo sieve and hash would be
    // interpreted as a direct same-lane heading. `@` remains ordinary glob text
    // and introduces the conventional `@(...)` extglob group.
    model.set("pattern-body-ne", [[
        cls([...CONTROL_RANGES, ...LINE_TERMINATORS, ...C(":#")], true),
        star(cls([...CONTROL_RANGES, ...LINE_TERMINATORS], true)),
    ]]);

    const addTags = [ref("add-tags-slot")];
    const target = [ref("target-slot")];
    const line = [ref("line-slot")];
    const taggedTargetScope = (op: string, lineRule = "line-slot"): GSeq => [
        lit(`## ${op}0`),
        opt(addTags[0]),
        target[0],
        opt(ref(lineRule)),
    ];
    const transfer = (op: "COPY" | "MOVE"): GSeq => [
        lit(`## ${op}0`),
        opt(addTags[0]),
        target[0],
        opt(ref("text-line-slot")),
        target[0],
        opt(ref("text-line-slot")),
    ];
    // Shape curation terms and canonical log addresses; the parser owns whether the
    // complete signal/target/matcher combination selects any log items.
    model.set("log-selection", [
        [ref("curation-tags-slot"), opt(ref("log-target-slot"))],
        [ref("log-target-slot")],
        [],
    ]);

    requiredBodySection(model, "plan", [lit("# PLAN0")]);
    optionalBodySection(model, "find", taggedTargetScope("FIND"), "pattern-body");
    optionalBodySection(model, "read", taggedTargetScope("READ", "text-line-slot"), "pattern-body");
    optionalBodySection(model, "edit", taggedTargetScope("EDIT", "text-line-slot"), "section-body");
    emptySection(model, "copy", transfer("COPY"));
    emptySection(model, "move", transfer("MOVE"));
    optionalBodySection(model, "open", [lit("## OPEN0"), ref("log-selection"), opt(ref("text-line-slot"))], "pattern-body");
    optionalBodySection(model, "fold", [lit("## FOLD0"), ref("log-selection"), opt(ref("text-line-slot"))], "pattern-body");
    optionalBodySection(model, "exec", [
        lit("## EXEC0"),
        opt(ref("exec-slot")),
        opt(target[0]),
        opt(line[0]),
    ], "section-body");
    requiredBodySection(model, "bare", [lit("## BARE0"), opt(ref("add-tags-slot"))]);
    requiredBodySection(model, "work", [lit("## WORK0"), opt(ref("branch-slot")), target[0]]);
    requiredBodySection(model, "fork", [lit("## FORK0"), opt(ref("branch-slot")), target[0]]);
    emptySection(model, "kill", [lit("## KILL0"), opt(ref("kill-slot")), target[0]]);

    const sendMidHeaders: GSeq[] = [
        [lit("## SEND0"), ref("status-mid-slot"), opt(ref("target-slot"))],
        [lit("## SEND0"), opt(ref("target-slot"))],
    ];
    model.set("send-mid", sendMidHeaders.flatMap((header): GRule => [
        [...header, opt(ref("annotation-slot")), lit("\n")],
        [...header, opt(ref("annotation-slot")), lit("\n"), ref("section-body-ne"), lit("\n")],
    ]));

    const final = (name: string, signal: string, park: boolean): void => {
        model.set(name, [[
            lit(`## SEND0 [${signal}]`),
            opt(ref("target-slot")),
            ...(park ? [opt(ref("park-slot"))] : []),
            opt(ref("annotation-slot")),
            lit("\n"),
            ref("section-body-ne"),
        ]]);
    };
    final("send-102", "102", false);
    final("send-200", "200", false);
    final("send-202", "202", true);
    final("send-499", "499", false);
    model.set("send-final-any", [[ref("send-102")], [ref("send-200")], [ref("send-202")], [ref("send-499")]]);
    model.set("send-final-first", [[ref("send-200")], [ref("send-202")], [ref("send-499")]]);

    model.set("op-statement", [
        [ref("find")], [ref("read")], [ref("edit")], [ref("copy")], [ref("move")],
        [ref("open")], [ref("fold")], [ref("exec")], [ref("bare")], [ref("work")], [ref("fork")], [ref("kill")],
    ]);

    const maxMidSteps = 14;
    for (let index = 0; index < maxMidSteps; index++) {
        model.set(`tail-${index}`, [
            [ref("send-mid"), ref(`tail-${index + 1}`)],
            [ref("op-statement"), ref(`tail-${index + 1}`)],
            [ref(index === 0 ? "send-final-first" : "send-final-any")],
        ]);
    }
    model.set(`tail-${maxMidSteps}`, [[ref("send-final-any")]]);

    model.set("sep", [Array.from({ length: 7 }, () => opt(WS))]);
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
    model.set("turn", [[ref("plan"), ref("tail-0")]]);
    model.set("framed-turn", [
        [ref("turn")],
        [lit("```plurnk\n"), ref("turn"), lit("\n```")],
    ]);
    model.set("root-gemma", [[ref("channel"), ref("sep"), ref("framed-turn")]]);
    model.set("root-qwen", [[ref("qwen-tail"), ref("sep"), ref("framed-turn")]]);
    model.set("root-qwen-response", [[lit(thinkOpen), ref("root-qwen")]]);

    model.set("statement", [[ref("op-statement")], [ref("send-mid")]]);
    model.set("send-statement", [[ref("send-mid")], [ref("send-final-any")]]);

    model.set("add-tags-slot", [[lit(" "), ref("add-tags")]]);
    model.set("curation-tags-slot", [[lit(" "), ref("curation-tags")]]);
    model.set("log-target-slot", [[lit(" (log:"), plus(ref("target-atom")), lit(")")]]);
    model.set("target-slot", [[lit(" "), ref("target"), star(ref("metadata-slot"))]]);
    model.set("metadata-slot", [[lit(" {"), star(bodyOther("{}", true)), lit("}")]]);
    model.set("line-slot", [[lit(" "), ref("line")]]);
    model.set("text-line-slot", [[lit(" "), ref("text-line")]]);
    model.set("exec-slot", [[lit(" "), ref("exec-sig")]]);
    model.set("branch-slot", [[lit(" "), ref("branch")]]);
    model.set("kill-slot", [[lit(" "), ref("kill-sig")]]);
    model.set("status-mid-slot", [[lit(" ["), ref("status-mid"), lit("]")]]);
    model.set("park-slot", [[lit(" "), ref("park")]]);
    model.set("annotation-slot", [[lit(" <!-- "), ref("annotation-body-ne"), lit(" -->")]]);

    model.set("status-mid", [
        [cls([R("0", "0"), R("5", "9")]), DIGIT, DIGIT],
        [lit("1"), ref("status-mid-1")],
        [lit("2"), ref("status-mid-2")],
        [lit("3"), ref("status-mid-3")],
        [lit("4"), ref("status-mid-4")],
    ]);
    model.set("status-mid-1", [[lit("0"), cls([R("0", "1"), R("3", "9")])], [cls([R("1", "9")]), DIGIT]]);
    model.set("status-mid-2", [[lit("0"), cls([R("1", "1"), R("3", "9")])], [cls([R("1", "9")]), DIGIT]]);
    model.set("status-mid-3", [[lit("0"), cls([R("0", "9")])], [cls([R("1", "9")]), DIGIT]]);
    model.set("status-mid-4", [[lit("9"), cls([R("0", "8")])], [cls([R("0", "8")]), DIGIT]]);

    model.set("add-tags", [[lit("["), ref("add-tag"), star(ref("add-tag-rest")), lit("]")]]);
    model.set("curation-tags", [[lit("["), ref("curation-term"), star(ref("curation-term-rest")), lit("]")]]);
    model.set("branch", [[lit("["), plus(BRANCH_CHAR), lit("]")]]);
    model.set("tag", [[TAG_HEAD, star(TAG_TAIL)]]);
    model.set("add-tag", [[lit("+"), ref("tag")]]);
    model.set("remove-tag", [[lit("-"), ref("tag")]]);
    model.set("signed-tag", [[ref("add-tag")], [ref("remove-tag")]]);
    model.set("curation-term", [[ref("tag")], [ref("signed-tag")]]);
    model.set("add-tag-rest", [[lit(","), ref("add-tag")]]);
    model.set("curation-term-rest", [[lit(","), ref("curation-term")]]);
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
    model.set("exec-sig", [[lit("["), EXEC_HEAD, star(EXEC_TAIL), lit("]")]]);
    model.set("kill-sig", [[lit("["), DIGIT, opt(DIGIT), lit("]")]]);
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
    process.stderr.write("Generated dist/plurnk.{gemma,qwen}.gbnf from one shared PLAN0/OP0 turn grammar\n");
}
