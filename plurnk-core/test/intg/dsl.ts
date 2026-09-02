// Test fixture builders route clean parameters through the contracts-owned
// statement parser so Core receives production AST shapes. {§tier-entrypoints}
// {§methods-op-mirror}

import { PLURNK_OPS, PlurnkParser } from "@plurnk/plurnk-contracts";
import type { LineMarker, PlurnkStatement } from "@plurnk/plurnk-contracts";

interface OpWithMatcher {
    target: string;
    matcher?: string;
    lineRange?: LineMarker;
}

interface OpEditParams {
    target: string;
    content?: string;
    lineRange?: LineMarker;
}

interface OpCopyMoveParams {
    source: string;
    destination?: string;
    lineRange?: LineMarker;
    destinationRange?: LineMarker;
}

// {§send-label} — a label concludes the turn and names no recipient; a recipient path (or
// none, the user) is a mid-turn message.
interface OpSendParams {
    status?: 102 | 200 | 202 | 499;
    recipient?: string;
    body?: string;
}

// {§exec-executor-slot} — `[executor]` leads; `{cwd=…}` names the directory; the body is the program.
interface OpExecParams {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class Dsl {
    // Use the canonical lane unless the body contains a heading in that lane;
    // then deterministically choose the first lane that leaves the body opaque.
    static #delimiterFor(body: string): string {
        const h2Ops = PLURNK_OPS.filter((op) => op !== "PLAN").join("|");
        for (let lane = 1; ; lane++) {
            const delimiter = String(lane);
            const structuralHeading = new RegExp(`^(?:# PLAN|## (?:${h2Ops}))${delimiter}(?=$|[ \\t])`, "m");
            if (!structuralHeading.test(body)) return delimiter;
        }
    }

    static #formatLineMarker(lm: LineMarker | undefined): string {
        if (lm === undefined || lm === null) return "";
        return `<${lm.marks.join(",")}>`;
    }

    static #formatPath(path: string | undefined): string {
        if (path === undefined) return "";
        return `(${path})`;
    }

    // Build one statement from its already-formatted path and scope slots.
    static #buildStatement({
        op, executor = "", target, metadata = "", lineMarker, body,
    }: {
        op: string;
        executor?: string;
        target: string;
        metadata?: string;
        lineMarker: string;
        body: string;
    }): string {
        const delimiter = Dsl.#delimiterFor(body);
        const modifiers = [executor, target, metadata, lineMarker].filter((value) => value.length > 0).join(" ");
        const heading = `## ${op}${delimiter}${modifiers.length > 0 ? ` ${modifiers}` : ""}`;
        return body.length === 0 ? heading : `${heading}\n${body}`;
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
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "EDIT",
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.content ?? "",
        }));
    }

    static buildRead(p: OpWithMatcher): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "READ",
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildFind(p: { scope: string; matcher?: string; tags?: string[]; lineRange?: LineMarker }): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "FIND",
            target: Dsl.#formatPath(p.scope),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildCopy(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.copy requires destination");
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "COPY",
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "MOVE",
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.destination === undefined
                ? ""
                : `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static #SEND_LABELS: Readonly<Record<number, string>> = Object.freeze({ 102: "NEXT", 200: "TERM", 202: "WAIT", 499: "FAIL" });

    static buildSend(p: OpSendParams): PlurnkStatement {
        if (p.status !== undefined && p.recipient !== undefined) throw new Error("a label SEND names no recipient");
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "SEND",
            target: p.status !== undefined ? `(${Dsl.#SEND_LABELS[p.status]})` : (p.recipient !== undefined ? Dsl.#formatPath(p.recipient) : ""),
            lineMarker: "",
            body: p.body ?? "",
        }));
    }

    static buildExec(p: OpExecParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "EXEC",
            executor: p.runtime === undefined ? "" : `[${p.runtime}]`,
            target: "",
            metadata: p.cwd === undefined ? "" : `{cwd=${p.cwd}}`,
            lineMarker: "",
            body: p.command ?? "",
        }));
    }
}
