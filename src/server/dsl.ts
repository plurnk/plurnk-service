// DSL helpers — clean-shape params → HEREDOC → PlurnkStatement. §methods-op-mirror
//
// Per the "Speak in DSL, not plumbing" Standing Rule: every op.* RPC method
// constructs a HEREDOC string from clean-shape params and parses it via the
// canonical grammar. This guarantees the resulting PlurnkStatement is
// IDENTICAL in shape to what the model would emit, including all
// scheme-specific path parsing rules (grammar 0.3.0+).
//
// The path-parser helper would let us bypass HEREDOC construction; tracked
// in plurnk-grammar issue #7.

import { PlurnkParser } from "@plurnk/plurnk-grammar";
import { LineMarkerOps } from "../content/index.ts";
import type { LineMarker, PlurnkStatement } from "@plurnk/plurnk-grammar";

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
        const { first, last } = LineMarkerOps.firstLast(lm);
        if (last === null || last === first) return `<${first}>`;
        return `<${first}-${last}>`;
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

    static parseSingleStatement(text: string): PlurnkStatement {
        const result = PlurnkParser.parse(text);
        for (const item of result.items) {
            if (item.kind === "statement") return item.statement;
        }
        throw new Error(`expected a parsed statement, got none from: ${text}`);
    }

    static parseAllStatements(text: string): PlurnkStatement[] {
        const result = PlurnkParser.parse(text);
        return result.items
            .filter((i) => i.kind === "statement")
            .map((i) => (i as { kind: "statement"; statement: PlurnkStatement }).statement);
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
            body: p.destination,
        }));
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "MOVE", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.destination ?? "",
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
