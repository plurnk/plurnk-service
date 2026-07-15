import { Lexer, type Token, type Tokens } from "marked";
import type { Diagnostic } from "./types.ts";

const PROSE_LIMIT = 280;

// plurnkdown linter. Only free prose (top-level paragraph blocks) is measured;
// every structural block — heading, list, table, fence, and the Gherkin/mermaid/
// op constructs built on them — is exempt by not being prose.
export default class Plurnkdown {
    lint(source: string): Diagnostic[] {
        const diagnostics: Diagnostic[] = [];
        let line = 1;
        for (const token of Lexer.lex(source)) {
            if (token.type === "paragraph") {
                this.#checkProse(token, line, diagnostics);
                this.#checkBareOps(token, line, diagnostics);
            }
            line += this.#newlines(token.raw);
        }
        return diagnostics;
    }

    // Free prose is capped by its RENDERED length — link URLs, emphasis marks, and
    // code ticks don't count; the reader's visible characters do.
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

    // A Plurnk op sigil (`<<`) opening a prose line is a bare op; ops must live in
    // a ```plurnk fence, which turns them into exempt structure.
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
