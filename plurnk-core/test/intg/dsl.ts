import { fixtureExecutors } from "./_helpers.ts";
// Test fixture builders route clean parameters through the contracts-owned
// statement parser so Core receives production AST shapes. {§tier-entrypoints}
// {§methods-op-mirror}

import { PlurnkParser } from "@plurnk/plurnk-contracts";
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

// {§turn-disposition} — SEND is messaging, never a disposition.
interface OpSendParams {
    recipient?: string;
    body?: string;
}

// {§exec-executor-slot} — the fence name selects the executor; `[{"cwd": "…"}]` names the directory; the body is the program.
interface OpExecParams {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class Dsl {
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
        const modifiers = [target, metadata, lineMarker].filter((value) => value.length > 0).join(" ");
        const header = `${executor || op}${modifiers.length > 0 ? ` ${modifiers}` : ""}`;
        return PlurnkParser.frame(header, body.length === 0 ? null : body);
    }

    static parseSingleStatement(text: string): PlurnkStatement {
        const result = PlurnkParser.parseStatements(text, { executors: fixtureExecutors(text) });
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
        const source = `${Dsl.#formatPath(p.source)} ${Dsl.#formatLineMarker(p.lineRange)}`.trim();
        const destination = `${Dsl.#formatPath(p.destination)} ${Dsl.#formatLineMarker(p.destinationRange)}`.trim();
        return Dsl.parseSingleStatement(PlurnkParser.frame(`COPY ${source} ${destination}`, null));
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.move requires destination");
        const source = `${Dsl.#formatPath(p.source)} ${Dsl.#formatLineMarker(p.lineRange)}`.trim();
        const destination = `${Dsl.#formatPath(p.destination)} ${Dsl.#formatLineMarker(p.destinationRange)}`.trim();
        return Dsl.parseSingleStatement(PlurnkParser.frame(`MOVE ${source} ${destination}`, null));
    }

    static buildSend(p: OpSendParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "SEND",
            target: Dsl.#formatPath(p.recipient),
            lineMarker: "",
            body: p.body ?? "",
        }));
    }

    static buildExec(p: OpExecParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "EXEC",
            executor: p.runtime ?? "",
            target: "",
            metadata: p.cwd === undefined ? "" : `[${JSON.stringify({ cwd: p.cwd })}]`,
            lineMarker: "",
            body: p.command ?? "",
        }));
    }
}
