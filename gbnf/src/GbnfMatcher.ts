// Faithful port of the llama.cpp grammar matcher (llama/src/llama-grammar.cpp):
// init builds the initial pushdown stacks for the root rule, accept(cp) advances them
// one code point. The C engine threads raw element pointers through stacks; the port
// uses (rule, pos) index pairs and dedups stacks by a serialized key rather than by
// pointer identity (the resulting stack *set* — hence the accept/incomplete/reject
// verdict — is identical regardless of visit order).

import { GRETYPE, type GrammarRule, type Stack, type StackRef } from "./types.ts";

export default class GbnfMatcher {
    #rules: GrammarRule[];
    #stacks: Stack[];

    constructor(rules: GrammarRule[], stacks: Stack[]) {
        this.#rules = rules;
        this.#stacks = stacks;
    }

    get stacks(): Stack[] { return this.#stacks; }

    // Returns the matcher, or null if the grammar lacks the root symbol or is
    // left-recursive — mirroring llama_grammar_init_impl returning nullptr.
    static init(rules: GrammarRule[], symbolIds: Map<string, number>, root: string): GbnfMatcher | null {
        if (!symbolIds.has(root)) return null;

        const n = rules.length;
        const visited = new Array<boolean>(n).fill(false);
        const inProgress = new Array<boolean>(n).fill(false);
        const mayBeEmpty = new Array<boolean>(n).fill(false);
        for (let i = 0; i < n; i++) {
            if (visited[i]) continue;
            if (GbnfMatcher.#detectLeftRecursion(rules, i, visited, inProgress, mayBeEmpty)) return null;
        }

        const startRule = symbolIds.get(root)!;
        const stacks: Stack[] = [];
        const keys = new Set<string>();
        let pos = 0;
        for (;;) {
            const stack: Stack = [];
            if (!GbnfMatcher.#isEnd(rules, startRule, pos)) stack.push({ rule: startRule, pos });
            GbnfMatcher.#advanceStack(rules, stack, stacks, keys);
            while (!GbnfMatcher.#isEnd(rules, startRule, pos)) pos++;
            if (rules[startRule][pos].type === GRETYPE.ALT) pos++;
            else break;
        }
        return new GbnfMatcher(rules, stacks);
    }

    accept(chr: number): void {
        const newStacks: Stack[] = [];
        const newKeys = new Set<string>();
        for (const stack of this.#stacks) GbnfMatcher.#acceptChr(this.#rules, stack, chr, newStacks, newKeys);
        this.#stacks = newStacks;
    }

    static #isEnd(rules: GrammarRule[], rule: number, pos: number): boolean {
        const t = rules[rule][pos].type;
        return t === GRETYPE.END || t === GRETYPE.ALT;
    }

    static #key(stack: Stack): string {
        let s = "";
        for (const r of stack) s += `${r.rule},${r.pos};`;
        return s;
    }

    // matches code point `chr` against the char-class element(s) starting at (rule, pos);
    // returns whether it matched and the position just past the class.
    static #matchChar(rules: GrammarRule[], rule: number, pos: number, chr: number): { found: boolean; next: number } {
        const r = rules[rule];
        let p = pos;
        let found = false;
        const isPositive = r[p].type === GRETYPE.CHAR || r[p].type === GRETYPE.CHAR_ANY;
        do {
            if (r[p + 1] && r[p + 1].type === GRETYPE.CHAR_RNG_UPPER) {
                found = found || (r[p].value <= chr && chr <= r[p + 1].value);
                p += 2;
            } else if (r[p].type === GRETYPE.CHAR_ANY) {
                found = true;
                p += 1;
            } else {
                found = found || r[p].value === chr;
                p += 1;
            }
        } while (r[p] && r[p].type === GRETYPE.CHAR_ALT);
        return { found: found === isPositive, next: p };
    }

    // expands a stack into all stacks whose top is a terminal (char/token) element
    static #advanceStack(rules: GrammarRule[], stack: Stack, newStacks: Stack[], newKeys: Set<string>): void {
        const todo: Stack[] = [stack];
        const seen = new Set<string>();
        while (todo.length) {
            const cur = todo.pop()!;
            const curKey = GbnfMatcher.#key(cur);
            if (seen.has(curKey)) continue;
            seen.add(curKey);

            if (cur.length === 0) {
                if (!newKeys.has("")) { newKeys.add(""); newStacks.push(cur); }
                continue;
            }

            const top = cur[cur.length - 1];
            const el = rules[top.rule][top.pos];
            switch (el.type) {
                case GRETYPE.RULE_REF: {
                    const ruleId = el.value;
                    let sp = 0;
                    for (;;) {
                        const next: Stack = cur.slice(0, cur.length - 1);
                        if (!GbnfMatcher.#isEnd(rules, top.rule, top.pos + 1)) next.push({ rule: top.rule, pos: top.pos + 1 });
                        if (!GbnfMatcher.#isEnd(rules, ruleId, sp)) next.push({ rule: ruleId, pos: sp });
                        todo.push(next);
                        while (!GbnfMatcher.#isEnd(rules, ruleId, sp)) sp++;
                        if (rules[ruleId][sp].type === GRETYPE.ALT) sp++;
                        else break;
                    }
                    break;
                }
                case GRETYPE.CHAR:
                case GRETYPE.CHAR_NOT:
                case GRETYPE.CHAR_ANY:
                case GRETYPE.TOKEN:
                case GRETYPE.TOKEN_NOT:
                    if (!newKeys.has(curKey)) { newKeys.add(curKey); newStacks.push(cur); }
                    break;
                default:
                    throw new Error("fatal error: stack left on a non-terminal element");
            }
        }
    }

    static #acceptChr(rules: GrammarRule[], stack: Stack, chr: number, newStacks: Stack[], newKeys: Set<string>): void {
        if (stack.length === 0) return;
        const top = stack[stack.length - 1];
        const el = rules[top.rule][top.pos];
        if (el.type === GRETYPE.TOKEN || el.type === GRETYPE.TOKEN_NOT) return;
        const m = GbnfMatcher.#matchChar(rules, top.rule, top.pos, chr);
        if (!m.found) return;
        const newStack: Stack = stack.slice(0, stack.length - 1);
        if (!GbnfMatcher.#isEnd(rules, top.rule, m.next)) newStack.push({ rule: top.rule, pos: m.next });
        GbnfMatcher.#advanceStack(rules, newStack, newStacks, newKeys);
    }

    static #detectLeftRecursion(
        rules: GrammarRule[],
        ruleIndex: number,
        visited: boolean[],
        inProgress: boolean[],
        mayBeEmpty: boolean[],
    ): boolean {
        if (inProgress[ruleIndex]) return true;
        inProgress[ruleIndex] = true;
        const rule = rules[ruleIndex];

        let atRuleStart = true;
        for (let i = 0; i < rule.length; i++) {
            if (rule[i].type === GRETYPE.END || rule[i].type === GRETYPE.ALT) {
                if (atRuleStart) { mayBeEmpty[ruleIndex] = true; break; }
                atRuleStart = true;
            } else {
                atRuleStart = false;
            }
        }

        let recurse = true;
        for (let i = 0; i < rule.length; i++) {
            if (rule[i].type === GRETYPE.RULE_REF && recurse) {
                if (GbnfMatcher.#detectLeftRecursion(rules, rule[i].value, visited, inProgress, mayBeEmpty)) return true;
                if (!mayBeEmpty[rule[i].value]) recurse = false;
            } else if (rule[i].type === GRETYPE.END || rule[i].type === GRETYPE.ALT) {
                recurse = true;
            } else {
                recurse = false;
            }
        }

        inProgress[ruleIndex] = false;
        visited[ruleIndex] = true;
        return false;
    }
}
