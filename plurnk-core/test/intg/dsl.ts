// DSL helpers — clean-shape params → HEREDOC → PlurnkStatement. §methods-op-mirror
//
// Per the "Speak in DSL, not plumbing" Standing Rule: every op.* RPC method
// constructs a HEREDOC string from clean-shape params and parses it via the
// canonical grammar. This guarantees the resulting PlurnkStatement is
// IDENTICAL in shape to what the model would emit, including all
// scheme-specific path parsing rules (grammar 0.3.0+).
//
// The path-parser helper would let us bypass HEREDOC construction; tracked
// in the canonical contracts grammar.

import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { LineMarker, PlurnkStatement } from "@plurnk/plurnk-contracts";

// A parse failure surfaced from raw DSL — an error item or an unterminated tail. `line`/`column`
// are 1-based positions in the CALLER's text (PLAN-prefix de-offset applied). §methods
export type ParseFailure = { message: string; line: number; column: number };

interface OpWithMatcher {
    target: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpEditParams {
    target: string;
    content?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpCopyMoveParams {
    source: string;
    destination?: string;
    tags?: string[];
    lineRange?: LineMarker;
    destinationRange?: LineMarker;
}

interface OpSendParams {
    status: number;
    recipient?: string;
    body?: string;
}

interface OpExecParams {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class Dsl {
    // Random suffix per call. Collision space is 2^32 against the user's body
    // content; vanishingly unlikely for any reasonable input.
    static #randomSuffix(): string {
        return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, "0");
    }

    static #formatTags(tags: string[] | undefined): string {
        if (tags === undefined || tags.length === 0) return "";
        return `[${tags.join(",")}]`;
    }

    static #formatLineMarker(lm: LineMarker | undefined): string {
        if (lm === undefined || lm === null) return "";
        return `<${lm.marks.join(",")}>`;
    }

    static #formatPath(path: string | undefined): string {
        if (path === undefined) return "";
        return `(${path})`;
    }

    // Build a HEREDOC statement string. `signal` is the raw signal payload —
    // CSV tags `[a,b,c]` for most ops, a single number for SEND (`[200]`),
    // a single runtime tag for EXEC (`[node]`).
    static #buildHeredoc({
        op, suffix, signal, target, lineMarker, body,
    }: {
        op: string;
        suffix: string;
        signal: string;
        target: string;
        lineMarker: string;
        body: string;
    }): string {
        return `<<${op}${suffix}${signal}${target}${lineMarker}:${body}:${op}${suffix}`;
    }

    // grammar 0.70: a turn must lead with PLAN (plurnk.md §Imperatives), so the
    // canonical parse of an op.*-built HEREDOC needs a PLAN prefix; we add it (when
    // absent) and strip the PLAN back out, returning only the real op(s).
    static #planPrefixed(text: string): string {
        return text.startsWith("<<PLAN") ? text : `<<PLAN::PLAN\n${text}`;
    }

    static parseSingleStatement(text: string): PlurnkStatement {
        const result = PlurnkParser.parse(Dsl.#planPrefixed(text));
        for (const item of result.items) {
            if (item.kind === "statement" && item.statement.op !== "PLAN") return item.statement;
        }
        throw new Error(`expected a parsed statement, got none from: ${text}`);
    }

    // Parse raw DSL into its statements AND its parse failures (error items + an unterminated
    // `unparsedTail`), so a caller surfaces failures instead of silently dropping them. Positions
    // are in the CALLER's text: when #planPrefixed injects a PLAN lead (one line), the parser's
    // line numbers are de-offset by 1.
    static parseAllStatements(text: string): { statements: PlurnkStatement[]; errors: ParseFailure[] } {
        const prefixed = !text.startsWith("<<PLAN");
        const result = PlurnkParser.parse(Dsl.#planPrefixed(text));
        const line = (l: number): number => prefixed ? Math.max(1, l - 1) : l;
        const statements: PlurnkStatement[] = [];
        const errors: ParseFailure[] = [];
        for (const item of result.items) {
            if (item.kind === "statement") {
                if (item.statement.op !== "PLAN") statements.push(item.statement);
            } else if (item.kind === "error") {
                // Drop the parser's "Plurnk <source> error at L:C — " prefix; the de-offset line:col
                // below is authoritative (the prefix's embedded L:C is in the PLAN-prefixed text).
                const message = item.error.message.replace(/^Plurnk \w+ error at (?:line )?\d+:\d+ [-—] /, "");
                // The parser emits benign turn-structure items for parse-and-dispatch input that isn't a
                // full turn — "unexpected end of input" (pre-0.74.34) / the imperative "a turn must begin
                // with PLAN" + "a turn must end with a terminal SEND" (0.74.34+). op.parse dispatches a
                // statement set, not a turn, so these are noise; the genuine unterminated case is the
                // unparsedTail below. Drop the scaffolding; keep real errors.
                if (message.startsWith("unexpected end of input") || message.startsWith("a turn must ")) continue;
                errors.push({ message, line: line(item.error.line), column: item.error.column });
            }
        }
        if (result.unparsedTail !== undefined) {
            const { from, reason } = result.unparsedTail;
            const deLined = prefixed ? reason.replace(/opened at line (\d+)/g, (_m, n) => `opened at line ${line(Number(n))}`) : reason;
            errors.push({ message: deLined, line: line(from.line), column: from.column });
        }
        return { statements, errors };
    }

    static buildEdit(p: OpEditParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "EDIT", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.content ?? "",
        }));
    }

    static buildRead(p: OpWithMatcher): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "READ", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildFind(p: { scope: string; matcher?: string; tags?: string[]; lineRange?: LineMarker }): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "FIND", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.scope),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildOpen(p: OpWithMatcher): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "OPEN", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildFold(p: OpWithMatcher): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "FOLD", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildCopy(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.copy requires destination");
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "COPY", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "MOVE", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.destination === undefined
                ? ""
                : `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static buildSend(p: OpSendParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "SEND", suffix: Dsl.#randomSuffix(),
            signal: `[${p.status}]`,
            target: p.recipient !== undefined ? Dsl.#formatPath(p.recipient) : "",
            lineMarker: "",
            body: p.body ?? "",
        }));
    }

    static buildExec(p: OpExecParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "EXEC", suffix: Dsl.#randomSuffix(),
            signal: p.runtime !== undefined ? `[${p.runtime}]` : "",
            target: p.cwd !== undefined ? Dsl.#formatPath(p.cwd) : "",
            lineMarker: "",
            body: p.command ?? "",
        }));
    }
}
