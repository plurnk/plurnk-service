import { Lexer, type Token, type Tokens } from "marked";
import { PLURNK_OPS, PlurnkParser } from "@plurnk/plurnk-contracts";
import type { Diagnostic } from "./types.ts";

const RUNON_LIMIT = 180; // a long run-on regardless of structure
const WELD_LIMIT = 120;  // a semicolon welding clauses in a non-trivial sentence
const PROTOCOL_OPS = new Set<string>(PLURNK_OPS);
const CLIENT_OPS = new Set(["LOOK", "BUFF"]);

// Structural blocks are not prose. Bare paragraph operations require fences;
// contracts owns fenced statement parsing. {§packet-operation-fences} {§packet-atomic-prose}
export default class Plurnkdown {
    lint(source: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        let line = 1;
        for (const token of Lexer.lex(source)) {
            if (token.type === "code" && (token as Tokens.Code).lang === "plurnk") {
                this.#checkFencedOps((token as Tokens.Code).text, line, diagnostics);
            } else {
                this.#checkBareOps(token, line, diagnostics);
                if (token.type === "paragraph") this.#checkRunOns(token, line, diagnostics);
            }
            line += this.#newlines(token.raw);
        }
        return diagnostics;
    }

    // A structural Plurnk heading outside a fence is a bare op. Markdown tokenizes
    // it as a heading, not prose, so inspect every non-fence block. {§op-shapes}
    #checkBareOps(token: Token, line: number, diagnostics: Diagnostic[]): void {
        token.raw.split("\n").forEach((text, index) => {
            const match = /^(#{1,2}) ([A-Z]+)[A-Za-z0-9_]*(?=$|[ \t])/.exec(text);
            if (match === null) return;
            const [, marks, op] = match;
            const isProtocolHeading = op === "PLAN"
                ? marks === "#"
                : marks === "##" && PROTOCOL_OPS.has(op);
            const isClientHeading = marks === "##" && CLIENT_OPS.has(op);
            if (!isProtocolHeading && !isClientHeading) return;
            diagnostics.push({
                rule: "op-fence",
                severity: "error",
                message: "Bare Plurnk op in prose; wrap it in a ```plurnk fence.",
                line: line + index,
                column: 1,
            });
        });
    }

    // Review heuristic for dense paragraph prose; never a structural-content gate.
    // {§packet-atomic-prose}
    #checkRunOns(token: Token, line: number, diagnostics: Diagnostic[]): void {
        const text = this.#visibleText((token as Tokens.Paragraph).tokens ?? []);
        // Per line, then per sentence — a soft line break is a unit boundary in this
        // one-idea-per-line style, so a multi-line paragraph isn't read as one run-on.
        for (const lineText of text.split("\n")) {
            for (const raw of lineText.split(/(?<=\.)\s+/)) {
                const sentence = raw.trim();
                if (sentence === "") continue;
                const welded = sentence.length >= WELD_LIMIT && sentence.includes(";");
                if (sentence.length < RUNON_LIMIT && !welded) continue;
                diagnostics.push({
                    rule: "run-on",
                    severity: "warning",
                    message: `Prose sentence is ${sentence.length} chars${welded ? " and semicolon-welded" : ""}; keep it atomic — split, don't weld.`,
                    line,
                    column: 1,
                });
            }
        }
    }

    // Delegate a ```plurnk fence's ops to the contracts grammar; surface every diagnostic and
    // tail at its absolute point. Fence line 1 sits below the opener. {§packet-operation-fences}
    #checkFencedOps(text: string, line: number, diagnostics: Diagnostic[]): void {
        const parsed = PlurnkParser.parseStatements(text);
        for (const item of parsed.items) {
            if (item.kind !== "error") continue;
            const { error } = item;
            diagnostics.push({
                rule: "op-syntax",
                severity: error.severity === "warning" ? "warning" : "error",
                message: error.message,
                line: line + error.line,
                column: error.column,
            });
        }
        if (parsed.unparsedTail !== undefined) {
            diagnostics.push({
                rule: "op-syntax",
                severity: "error",
                message: parsed.unparsedTail.reason,
                line: line + parsed.unparsedTail.from.line,
                column: parsed.unparsedTail.from.column,
            });
        }
    }

    #visibleText(tokens: Token[]): string {
        let out = "";
        for (const token of tokens) {
            if (token.type === "br") continue;
            const children = (token as { tokens?: Token[] }).tokens;
            if (children && children.length > 0) { out += this.#visibleText(children); continue; }
            const leaf = token as { text?: string; raw?: string };
            out += leaf.text ?? leaf.raw ?? "";
        }
        return out;
    }

    #newlines(raw: string): number {
        return raw.split("\n").length - 1;
    }
}
