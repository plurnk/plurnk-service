import { BaseErrorListener, CommonTokenStream, ListTokenSource, type Token } from "antlr4ng";
import { PlurnkParseError, isPlurnkOp, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import HeadingTokens from "./HeadingTokens.ts";
import { isReasoningOperation } from "./ReasoningOperation.ts";

export class HeadingErrors extends BaseErrorListener {
    failed = false;
    override syntaxError(): void { this.failed = true; }
}

// {§whitespace-contract}: a heading-only grammar pass supplies shape to fence recovery.
// It never pairs fences or admits operations; the full parse owns errors and advisories.
export default class HeadingReader {
    // {§fence-pairing}: the lexer and fence pairing share recognition; the slot grammar validates
    // what follows. A slot opener suffices even when its slot is malformed, so it receives a diagnostic.
    static opens(name: string, suffix: string, executors: ReadonlySet<string>, reasoning: boolean): boolean {
        if (reasoning) return isReasoningOperation(name);
        if (isPlurnkOp(name)) return true;
        const lower = name.toLowerCase();
        for (const executor of executors) if (executor.toLowerCase() === lower) return true;
        const next = suffix.replace(/^[ \t]*/u, "");
        return next.startsWith("(") || next.startsWith("[") || next.startsWith("<") && !next.startsWith("<!--");
    }

    static read(tokens: readonly Token[], errors: HeadingErrors): PlurnkStatement | null {
        if (errors.failed) return null;
        const parser = new plurnkParser(new CommonTokenStream(new ListTokenSource(HeadingTokens.normalize(tokens))));
        parser.removeErrorListeners();
        parser.addErrorListener(errors);
        const ctx = parser.statement();
        if (errors.failed) return null;
        try {
            const { value } = AstBuilder.collectAdvisories(() => AstBuilder.build(ctx));
            return value[0] ?? null;
        } catch (cause) {
            // Invalid slots remain invalid in the full parse, with their original diagnostic.
            if (!(cause instanceof PlurnkParseError)) throw cause;
            return null;
        }
    }
}
