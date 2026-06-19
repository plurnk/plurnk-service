// Faithful port of llama_grammar_parser (llama/src/llama-grammar.cpp): parses GBNF text
// into the rule table the matcher executes. Operates on the raw UTF-8 bytes of the
// grammar, mirroring the C engine's `const char *` pointer arithmetic exactly — index ==
// byte offset, and `#at` past the end returns 0 to stand in for C's NUL terminator.

import { GRETYPE, type GrammarRule } from "./types.ts";

const MAX_REPETITION_THRESHOLD = 2000;
// byte index per high nibble of the first UTF-8 byte (matches decode_utf8's lookup)
const UTF8_LEN = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4];

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isWord = (c: number): boolean =>
    (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x2d || isDigit(c);

export default class GbnfParser {
    #b: Uint8Array;
    #rules: GrammarRule[] = [];
    #symbolIds = new Map<string, number>();
    #ok = false;

    constructor(grammar: string) {
        this.#b = new TextEncoder().encode(grammar);
    }

    static parse(grammar: string): GbnfParser {
        const parser = new GbnfParser(grammar);
        parser.#parse();
        return parser;
    }

    get ok(): boolean { return this.#ok; }
    get rules(): GrammarRule[] { return this.#rules; }
    get symbolIds(): Map<string, number> { return this.#symbolIds; }

    #at(i: number): number { return i >= 0 && i < this.#b.length ? this.#b[i] : 0; }
    #str(pos: number, len: number): string { return new TextDecoder().decode(this.#b.subarray(pos, pos + len)); }
    #from(pos: number): string { return new TextDecoder().decode(this.#b.subarray(pos)); }

    #decodeUtf8(pos: number): [number, number] {
        const first = this.#at(pos);
        const len = UTF8_LEN[first >> 4];
        const mask = (1 << (8 - len)) - 1;
        let value = first & mask;
        const end = pos + len;
        let p = pos + 1;
        for (; p < end && this.#at(p); p++) value = (value << 6) + (this.#at(p) & 0x3f);
        return [value, p];
    }

    #parseHex(pos: number, size: number): [number, number] {
        let p = pos;
        const end = pos + size;
        let value = 0;
        for (; p < end && this.#at(p); p++) {
            value <<= 4;
            const c = this.#at(p);
            if (c >= 0x61 && c <= 0x66) value += c - 0x61 + 10;
            else if (c >= 0x41 && c <= 0x46) value += c - 0x41 + 10;
            else if (c >= 0x30 && c <= 0x39) value += c - 0x30;
            else break;
        }
        if (p !== end) throw new Error(`expecting ${size} hex chars at ${this.#from(pos)}`);
        return [value, p];
    }

    #parseSpace(pos: number, newlineOk: boolean): number {
        let p = pos;
        for (;;) {
            const c = this.#at(p);
            if (c === 0x20 || c === 0x09 || c === 0x23 || (newlineOk && (c === 0x0d || c === 0x0a))) {
                if (c === 0x23) while (this.#at(p) && this.#at(p) !== 0x0d && this.#at(p) !== 0x0a) p++;
                else p++;
            } else break;
        }
        return p;
    }

    #parseName(pos: number): number {
        let p = pos;
        while (isWord(this.#at(p))) p++;
        if (p === pos) throw new Error(`expecting name at ${this.#from(pos)}`);
        return p;
    }

    #parseInt(pos: number): number {
        let p = pos;
        while (isDigit(this.#at(p))) p++;
        if (p === pos) throw new Error(`expecting integer at ${this.#from(pos)}`);
        return p;
    }

    #parseChar(pos: number): [number, number] {
        const c = this.#at(pos);
        if (c === 0x5c) {
            const n = this.#at(pos + 1);
            switch (n) {
                case 0x78: return this.#parseHex(pos + 2, 2); // \x
                case 0x75: return this.#parseHex(pos + 2, 4); // \u
                case 0x55: return this.#parseHex(pos + 2, 8); // \U
                case 0x74: return [0x09, pos + 2]; // \t
                case 0x72: return [0x0d, pos + 2]; // \r
                case 0x6e: return [0x0a, pos + 2]; // \n
                case 0x5c: case 0x22: case 0x5b: case 0x5d: return [n, pos + 2]; // \\ \" \[ \]
                default: throw new Error(`unknown escape at ${this.#from(pos)}`);
            }
        }
        if (c) return this.#decodeUtf8(pos);
        throw new Error("unexpected end of input");
    }

    // <[id]> numeric tokens parse without a vocab; the text form cannot (the validator
    // has none), exactly as in the C engine.
    #parseToken(pos: number): [number, number] {
        let p = pos;
        if (this.#at(p) !== 0x3c) throw new Error(`expecting '<' at ${this.#from(p)}`);
        p++;
        if (this.#at(p) === 0x5b) {
            p++;
            const intEnd = this.#parseInt(p);
            const tokenId = Number(this.#str(p, intEnd - p));
            p = intEnd;
            if (this.#at(p) !== 0x5d) throw new Error(`expecting ']' at ${this.#from(p)}`);
            p++;
            if (this.#at(p) !== 0x3e) throw new Error(`expecting '>' at ${this.#from(p)}`);
            p++;
            return [tokenId, p];
        }
        throw new Error(`no vocab to parse token at ${this.#from(p)}`);
    }

    #getSymbolId(pos: number, len: number): number {
        const name = this.#str(pos, len);
        const existing = this.#symbolIds.get(name);
        if (existing !== undefined) return existing;
        const id = this.#symbolIds.size;
        this.#symbolIds.set(name, id);
        return id;
    }

    #generateSymbolId(baseName: string): number {
        const id = this.#symbolIds.size;
        this.#symbolIds.set(`${baseName}_${id}`, id);
        return id;
    }

    #addRule(id: number, rule: GrammarRule): void {
        while (this.#rules.length <= id) this.#rules.push([]);
        this.#rules[id] = rule;
    }

    #parseAlternates(pos: number, ruleName: string, ruleId: number, isNested: boolean): number {
        const rule: GrammarRule = [];
        let p = this.#parseSequence(pos, ruleName, rule, isNested);
        while (this.#at(p) === 0x7c) { // |
            rule.push({ type: GRETYPE.ALT, value: 0 });
            p = this.#parseSpace(p + 1, true);
            p = this.#parseSequence(p, ruleName, rule, isNested);
        }
        rule.push({ type: GRETYPE.END, value: 0 });
        this.#addRule(ruleId, rule);
        return p;
    }

    #parseSequence(pos: number, ruleName: string, rule: GrammarRule, isNested: boolean): number {
        let lastSymStart = rule.length;
        let nPrevRules = 1;
        let p = pos;

        const handleRepetitions = (minTimes: number, maxTimes: number): void => {
            const noMax = maxTimes === Infinity;
            if (lastSymStart === rule.length)
                throw new Error(`expecting preceding item to */+/?/{ at ${this.#from(p)}`);

            const prevRule = rule.slice(lastSymStart).map((e) => ({ ...e }));
            let totalRules = 1;
            if (!noMax && maxTimes > 0) totalRules = maxTimes;
            else if (minTimes > 0) totalRules = minTimes;

            if (nPrevRules * totalRules >= MAX_REPETITION_THRESHOLD)
                throw new Error("number of repeated rules exceeds sane defaults");

            if (minTimes === 0) {
                rule.length = lastSymStart;
            } else {
                for (let i = 1; i < minTimes; i++) for (const e of prevRule) rule.push({ ...e });
            }

            let lastRecRuleId = 0;
            const nOpt = noMax ? 1 : maxTimes - minTimes;
            const recRule = prevRule.map((e) => ({ ...e }));
            for (let i = 0; i < nOpt; i++) {
                recRule.length = prevRule.length;
                const recRuleId = this.#generateSymbolId(ruleName);
                if (i > 0 || noMax)
                    recRule.push({ type: GRETYPE.RULE_REF, value: noMax ? recRuleId : lastRecRuleId });
                recRule.push({ type: GRETYPE.ALT, value: 0 });
                recRule.push({ type: GRETYPE.END, value: 0 });
                this.#addRule(recRuleId, recRule.map((e) => ({ ...e })));
                lastRecRuleId = recRuleId;
            }
            if (nOpt > 0) rule.push({ type: GRETYPE.RULE_REF, value: lastRecRuleId });
            nPrevRules *= totalRules;
        };

        while (this.#at(p)) {
            const c = this.#at(p);
            if (c === 0x22) { // "literal"
                p++;
                lastSymStart = rule.length;
                nPrevRules = 1;
                while (this.#at(p) !== 0x22) {
                    if (!this.#at(p)) throw new Error("unexpected end of input");
                    const [value, next] = this.#parseChar(p);
                    p = next;
                    rule.push({ type: GRETYPE.CHAR, value });
                }
                p = this.#parseSpace(p + 1, isNested);
            } else if (c === 0x5b) { // [char range]
                p++;
                let startType: number = GRETYPE.CHAR;
                if (this.#at(p) === 0x5e) { p++; startType = GRETYPE.CHAR_NOT; } // ^
                lastSymStart = rule.length;
                nPrevRules = 1;
                while (this.#at(p) !== 0x5d) { // ]
                    if (!this.#at(p)) throw new Error("unexpected end of input");
                    const [value, next] = this.#parseChar(p);
                    p = next;
                    const type = lastSymStart < rule.length ? GRETYPE.CHAR_ALT : startType;
                    rule.push({ type, value });
                    if (this.#at(p) === 0x2d && this.#at(p + 1) !== 0x5d) { // '-' not followed by ']'
                        if (!this.#at(p + 1)) throw new Error("unexpected end of input");
                        const [upper, endNext] = this.#parseChar(p + 1);
                        p = endNext;
                        rule.push({ type: GRETYPE.CHAR_RNG_UPPER, value: upper });
                    }
                }
                p = this.#parseSpace(p + 1, isNested);
            } else if (c === 0x3c || c === 0x21) { // <token> or !<token>
                let type: number = GRETYPE.TOKEN;
                if (c === 0x21) { type = GRETYPE.TOKEN_NOT; p++; }
                const [value, tokEnd] = this.#parseToken(p);
                lastSymStart = rule.length;
                nPrevRules = 1;
                rule.push({ type, value });
                p = this.#parseSpace(tokEnd, isNested);
            } else if (isWord(c)) { // rule reference
                const nameEnd = this.#parseName(p);
                const refRuleId = this.#getSymbolId(p, nameEnd - p);
                p = this.#parseSpace(nameEnd, isNested);
                lastSymStart = rule.length;
                nPrevRules = 1;
                rule.push({ type: GRETYPE.RULE_REF, value: refRuleId });
            } else if (c === 0x28) { // (grouping)
                p = this.#parseSpace(p + 1, true);
                const nRulesBefore = this.#symbolIds.size;
                const subRuleId = this.#generateSymbolId(ruleName);
                p = this.#parseAlternates(p, ruleName, subRuleId, true);
                nPrevRules = Math.max(1, this.#symbolIds.size - nRulesBefore);
                lastSymStart = rule.length;
                rule.push({ type: GRETYPE.RULE_REF, value: subRuleId });
                if (this.#at(p) !== 0x29) throw new Error(`expecting ')' at ${this.#from(p)}`);
                p = this.#parseSpace(p + 1, isNested);
            } else if (c === 0x2e) { // .
                lastSymStart = rule.length;
                nPrevRules = 1;
                rule.push({ type: GRETYPE.CHAR_ANY, value: 0 });
                p = this.#parseSpace(p + 1, isNested);
            } else if (c === 0x2a) { // *
                p = this.#parseSpace(p + 1, isNested);
                handleRepetitions(0, Infinity);
            } else if (c === 0x2b) { // +
                p = this.#parseSpace(p + 1, isNested);
                handleRepetitions(1, Infinity);
            } else if (c === 0x3f) { // ?
                p = this.#parseSpace(p + 1, isNested);
                handleRepetitions(0, 1);
            } else if (c === 0x7b) { // {m} {m,} {m,n}
                p = this.#parseSpace(p + 1, isNested);
                if (!isDigit(this.#at(p))) throw new Error(`expecting an int at ${this.#from(p)}`);
                let intEnd = this.#parseInt(p);
                const minTimes = Number(this.#str(p, intEnd - p));
                p = this.#parseSpace(intEnd, isNested);
                let maxTimes = Infinity;
                if (this.#at(p) === 0x7d) { // }
                    maxTimes = minTimes;
                    p = this.#parseSpace(p + 1, isNested);
                } else if (this.#at(p) === 0x2c) { // ,
                    p = this.#parseSpace(p + 1, isNested);
                    if (isDigit(this.#at(p))) {
                        intEnd = this.#parseInt(p);
                        maxTimes = Number(this.#str(p, intEnd - p));
                        p = this.#parseSpace(intEnd, isNested);
                    }
                    if (this.#at(p) !== 0x7d) throw new Error(`expecting '}' at ${this.#from(p)}`);
                    p = this.#parseSpace(p + 1, isNested);
                } else {
                    throw new Error(`expecting ',' at ${this.#from(p)}`);
                }
                const hasMax = maxTimes !== Infinity;
                if (minTimes > MAX_REPETITION_THRESHOLD || (hasMax && maxTimes > MAX_REPETITION_THRESHOLD))
                    throw new Error("number of repetitions exceeds sane defaults");
                handleRepetitions(minTimes, maxTimes);
            } else {
                break;
            }
        }
        return p;
    }

    #parseRule(pos: number): number {
        const nameEnd = this.#parseName(pos);
        let p = this.#parseSpace(nameEnd, false);
        const nameLen = nameEnd - pos;
        const ruleId = this.#getSymbolId(pos, nameLen);
        const name = this.#str(pos, nameLen);
        if (!(this.#at(p) === 0x3a && this.#at(p + 1) === 0x3a && this.#at(p + 2) === 0x3d))
            throw new Error(`expecting ::= at ${this.#from(p)}`);
        p = this.#parseSpace(p + 3, true);
        p = this.#parseAlternates(p, name, ruleId, false);
        if (this.#at(p) === 0x0d) p += this.#at(p + 1) === 0x0a ? 2 : 1;
        else if (this.#at(p) === 0x0a) p++;
        else if (this.#at(p)) throw new Error(`expecting newline or end at ${this.#from(p)}`);
        return this.#parseSpace(p, true);
    }

    #parse(): boolean {
        try {
            let p = this.#parseSpace(0, true);
            while (this.#at(p)) p = this.#parseRule(p);
            // every rule must be defined and every reference must resolve
            for (const rule of this.#rules) {
                if (rule.length === 0) throw new Error("Undefined rule");
                for (const elem of rule) {
                    if (elem.type === GRETYPE.RULE_REF && (elem.value >= this.#rules.length || this.#rules[elem.value].length === 0)) {
                        for (const [k, v] of this.#symbolIds)
                            if (v === elem.value) throw new Error(`Undefined rule identifier '${k}'`);
                    }
                }
            }
            this.#ok = true;
        } catch {
            this.#rules = [];
            this.#ok = false;
        }
        return this.#ok;
    }
}
