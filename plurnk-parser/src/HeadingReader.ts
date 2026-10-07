import { BaseErrorListener, CommonTokenStream, ListTokenSource, type Token } from "antlr4ng";
import { PlurnkParseError, type ClientStatement } from "@plurnk/plurnk-contracts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import HeadingTokens from "./HeadingTokens.ts";

export class HeadingErrors extends BaseErrorListener {
    failed = false;
    override syntaxError(): void { this.failed = true; }
}

// {§parser-architecture}: a heading-only grammar pass supplies shape to fence recovery.
// It never pairs fences or admits operations; the full parse owns errors and advisories.
export default class HeadingReader {
    static read(tokens: readonly Token[], errors: HeadingErrors): ClientStatement | null {
        if (errors.failed) return null;
        const parser = new plurnkParser(new CommonTokenStream(new ListTokenSource(HeadingTokens.normalize(tokens))));
        parser.removeErrorListeners();
        parser.addErrorListener(errors);
        const ctx = parser.clientStatement();
        if (errors.failed) return null;
        try {
            const { value } = AstBuilder.collectAdvisories(() => AstBuilder.buildClient(ctx));
            return value[0] ?? null;
        } catch (cause) {
            // Invalid slots remain invalid in the full parse, with their original diagnostic.
            if (!(cause instanceof PlurnkParseError)) throw cause;
            return null;
        }
    }
}
