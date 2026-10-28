import { BaseErrorListener, CommonTokenStream, ListTokenSource, type Token } from "antlr4ng";
import { PlurnkParseError, isPlurnkOp, type PlurnkOp, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { plurnkParser } from "./generated/plurnkParser.ts";
import AstBuilder from "./AstBuilder.ts";
import HeadingTokens from "./HeadingTokens.ts";
import { isReasoningOperation } from "./ReasoningOperation.ts";

const JS_ALIASES = ["ts", "javascript", "typescript", "node"] as const;

export class HeadingErrors extends BaseErrorListener {
    failed = false;
    override syntaxError(): void { this.failed = true; }
}

// {§whitespace-contract}: a heading-only grammar pass supplies shape to fence recovery.
// It never pairs fences or admits operations; the full parse owns errors and advisories.
export default class HeadingReader {
    static readonly NAME = /^[A-Za-z0-9_.+-]+/u;

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

    // {§operation-fences}: a native name alone or with one complete aside on its line, outside reasoning.
    static nakedHeading(text: string, reasoning: boolean): { name: PlurnkOp; alone: boolean } | null {
        if (reasoning) return null;
        const match = /^([A-Z]+)(?:[ \t]*(<!--(?:(?!-->)[^\r\n])*-->))?[ \t]*$/u.exec(text);
        if (match === null || !isPlurnkOp(match[1])) return null;
        return { name: match[1], alone: match[2] === undefined };
    }

    // {§fence-pairing}: canonicalize known executor spellings and JavaScript aliases before runtime admission.
    static executorSpellings(knownExecutors: Set<string>, configured: readonly string[] = []): Map<string, string> {
        for (const name of configured) knownExecutors.add(name);
        const spellings = new Map([...knownExecutors].map((name) => [name.toLowerCase(), name]));
        const js = spellings.get("js");
        if (js !== undefined) {
            for (const alias of JS_ALIASES) {
                if (!spellings.has(alias)) {
                    knownExecutors.add(alias);
                    spellings.set(alias, js);
                }
            }
        }
        return spellings;
    }

    // {§fence-pairing}: a plurnk operation name, case-insensitively, or a known executor by its canonical spelling.
    static resolveOperationOrExecutor(raw: string, known: ReadonlySet<string>): string | null {
        const name = raw.trim();
        const upper = name.toUpperCase();
        if (isPlurnkOp(upper)) return upper;
        const lower = name.toLowerCase();
        if (lower === "bash" && !known.has("bash") && known.has("sh")) return "sh";
        if ((JS_ALIASES as readonly string[]).includes(lower) && !known.has(lower) && known.has("js")) return "js";
        return known.has(lower) ? name : null;
    }

    static read(tokens: readonly Token[], errors: HeadingErrors): PlurnkStatement | null {
        if (errors.failed) return null;
        const parser = new plurnkParser(new CommonTokenStream(new ListTokenSource(HeadingTokens.normalize(tokens))));
        parser.removeErrorListeners();
        parser.addErrorListener(errors);
        const ctx = parser.statement();
        if (errors.failed) return null;
        try {
            const { statements } = AstBuilder.build(ctx);
            return statements[0] ?? null;
        } catch (cause) {
            // Invalid slots remain invalid in the full parse, with their original diagnostic.
            if (!(cause instanceof PlurnkParseError)) throw cause;
            return null;
        }
    }
}
