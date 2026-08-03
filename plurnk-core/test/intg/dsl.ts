// Test fixture builders route clean parameters through the contracts-owned
// statement parser so Core receives production AST shapes. {§tier-entrypoints}
// {§methods-op-mirror}

import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { LineMarker, PlurnkStatement } from "@plurnk/plurnk-contracts";

interface OpWithMatcher {
    target: string;
    matcher?: string;
    tags?: string[];
    lineRange?: LineMarker;
}

interface OpCuration {
    target: string;
    matcher?: string;
    tags?: string[];
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

    static parseSingleStatement(text: string): PlurnkStatement {
        const result = PlurnkParser.parseStatements(text);
        const statements: PlurnkStatement[] = [];
        const failures: string[] = [];
        for (const item of result.items) {
            if (item.kind === "statement") statements.push(item.statement);
            else if (item.kind === "error") failures.push(item.error.message);
            else failures.push("unexpected interstatement text");
        }
        if (result.unparsedTail !== undefined) failures.push(result.unparsedTail.reason);
        const [statement] = statements;
        if (statement === undefined || statements.length !== 1 || failures.length !== 0) {
            const detail = failures.length === 0 ? "" : `: ${failures.join("; ")}`;
            throw new Error(`expected exactly one parsed statement, got ${statements.length}${detail}`);
        }
        return statement;
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

    static buildOpen(p: OpCuration): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "OPEN", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: "",
            body: p.matcher ?? "",
        }));
    }

    static buildFold(p: OpCuration): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildHeredoc({
            op: "FOLD", suffix: Dsl.#randomSuffix(),
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: "",
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
