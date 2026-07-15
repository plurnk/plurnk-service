import { Lexer, type Token, type Tokens } from "marked";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type { Diagnostic } from "./types.ts";

const PROSE_LIMIT = 280;
const RUNON_LIMIT = 180; // a long run-on regardless of structure
const WELD_LIMIT = 120;  // a semicolon welding clauses in a non-trivial sentence

// plurnkdown linter. Free prose (top-level paragraphs) is capped by rendered length;
// every structural block is exempt by not being prose. Ops written bare in prose are
// flagged for fencing; ops inside a ```plurnk fence are delegated to plurnk-grammar
// for statement-level validation.
export default class Plurnkdown {
    lint(source: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        let line = 1;
        for (const token of Lexer.lex(source)) {
            if (token.type === "paragraph") {
                this.#checkProse(token, line, diagnostics);
                this.#checkBareOps(token, line, diagnostics);
                this.#checkRunOns(token, line, diagnostics);
            } else if (token.type === "code" && (token as Tokens.Code).lang === "plurnk") {
                this.#checkFencedOps((token as Tokens.Code).text, line, diagnostics);
            }
            line += this.#newlines(token.raw);
        }
        return diagnostics;
    }

    // Free prose is capped by RENDERED length — link URLs, emphasis marks, and code
    // ticks don't count; the reader's visible characters do.
    #checkProse(token: Token, line: number, diagnostics: Diagnostic[]): void {
        const length = this.#visibleText((token as Tokens.Paragraph).tokens ?? []).trim().length;
        if (length <= PROSE_LIMIT) return;
        diagnostics.push({
            rule: "prose-280",
            severity: "error",
            message: `Free prose block renders ${length} characters; the limit is ${PROSE_LIMIT}.`,
            line,
            column: 1,
        });
    }

    // A Plurnk op sigil (`<<`) opening a prose line is a bare op; ops must live in a
    // ```plurnk fence (validated below) or an inline-code span.
    #checkBareOps(token: Token, line: number, diagnostics: Diagnostic[]): void {
        token.raw.split("\n").forEach((text, index) => {
            if (!/^\s*<</.test(text)) return;
            diagnostics.push({
                rule: "op-fence",
                severity: "error",
                message: "Bare Plurnk op in prose; wrap it in a ```plurnk fence.",
                line: line + index,
                column: 1,
            });
        });
    }

    // Soft-warn (#453): the floor model reads short atomic sentences better than dense
    // compounds. Flag a long run-on (>= RUNON_LIMIT) or a semicolon-welded clause pair
    // (>= WELD_LIMIT with a `;`). A `;` is not treated as a sentence split — the weld
    // IS the anti-pattern. Warning, not error: it's a heuristic for human review.
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

    // Delegate a ```plurnk fence's ops to plurnk-grammar; surface each syntax error at
    // its absolute line. Fence content line 1 sits one line below the opening fence.
    #checkFencedOps(text: string, line: number, diagnostics: Diagnostic[]): void {
        for (const item of PlurnkParser.parseStatements(text).items) {
            if (item.kind !== "error") continue;
            const error = (item as { error: { line: number; column: number; severity: string; message: string } }).error;
            diagnostics.push({
                rule: "op-syntax",
                severity: error.severity === "warning" ? "warning" : "error",
                message: error.message.replace(/^Plurnk \w+ error at line \d+:\d+ - /, ""),
                line: line + error.line,
                column: error.column,
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
