import { Lexer, type Token, type Tokens } from "marked";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { Diagnostic } from "./types.ts";

const RUNON_LIMIT = 180; // a long run-on regardless of structure
const WELD_LIMIT = 120;  // a semicolon welding clauses in a non-trivial sentence
// Structural blocks are not prose;
// contracts owns fenced statement parsing. {§packet-operation-fences} {§packet-atomic-prose}
export default class Plurnkdown {
    lint(source: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        let line = 1;
        for (const token of Lexer.lex(source)) {
            if (token.type === "code" && /^[A-Za-z][A-Za-z0-9_.+-]*(?:\s|$)/.test((token as Tokens.Code).lang ?? "")) {
                this.#checkFencedOps(token.raw, line, diagnostics);
            } else {
                if (token.type === "paragraph") {
                    token.raw.split("\n").forEach((text, offset) => {
                        if (/^(`{3,})[A-Za-z][^\n]*\1\s*$/.test(text)) this.#checkFencedOps(text, line + offset, diagnostics);
                    });
                    this.#checkRunOns(token, line, diagnostics);
                }
            }
            line += this.#newlines(token.raw);
        }
        return diagnostics;
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

    // Parse the complete executable block, preserving its closing boundary. {§packet-operation-fences}
    #checkFencedOps(text: string, line: number, diagnostics: Diagnostic[]): void {
        const parsed = PlurnkParser.parseStatements(text);
        for (const item of parsed.items) {
            if (item.kind !== "error") continue;
            const { error } = item;
            diagnostics.push({
                rule: "op-syntax",
                severity: error.severity === "warning" ? "warning" : "error",
                message: error.message,
                line: line + error.line - 1,
                column: error.column,
            });
        }
        if (parsed.unparsedTail !== undefined) {
            diagnostics.push({
                rule: "op-syntax",
                severity: "error",
                message: parsed.unparsedTail.reason,
                line: line + parsed.unparsedTail.from.line - 1,
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
