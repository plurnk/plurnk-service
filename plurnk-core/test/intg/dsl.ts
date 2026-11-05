import { fixtureExecutors } from "./_mock.ts";
// Test fixture builders route clean parameters through the contracts-owned
// statement parser so Core receives production AST shapes. {§whitespace-contract}
// {§methods}

import { PlurnkParser } from "@plurnk/plurnk-parser";
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

// {§op-shapes} — SEND is messaging, never a disposition.
interface OpSendParams {
    recipient?: string;
    body?: string;
}

// {§op-shapes} — the runtime selects the executor; `cwd` names the directory; `command` is the program.
interface OpExecParams {
    cwd?: string;
    runtime?: string;
    command?: string;
}

export default class Dsl {
    static #formatRange(lm: LineMarker | undefined): string | undefined {
        if (lm === undefined || lm === null) return undefined;
        return lm.marks.join(",");
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
        const range = Dsl.#formatRange(p.lineRange);
        return Dsl.parseSingleStatement(`await plurnk.edit(${JSON.stringify({
            path: p.target,
            ...(range === undefined ? {} : { range }),
            ...(p.content === undefined || p.content.length === 0 ? {} : { content: p.content }),
        })});`);
    }

    static buildRead(p: OpWithMatcher): PlurnkStatement {
        const range = Dsl.#formatRange(p.lineRange);
        return Dsl.parseSingleStatement(`await plurnk.read(${JSON.stringify({
            path: p.target,
            ...(range === undefined ? {} : { range }),
            ...(p.matcher === undefined || p.matcher.length === 0 ? {} : { pattern: p.matcher }),
        })});`);
    }

    static buildFind(p: { scope: string; matcher?: string; tags?: string[]; lineRange?: LineMarker }): PlurnkStatement {
        const range = Dsl.#formatRange(p.lineRange);
        return Dsl.parseSingleStatement(`await plurnk.find(${JSON.stringify({
            path: p.scope,
            ...(range === undefined ? {} : { range }),
            ...(p.matcher === undefined || p.matcher.length === 0 ? {} : { pattern: p.matcher }),
        })});`);
    }

    static buildCopy(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.copy requires destination");
        const srcRange = Dsl.#formatRange(p.lineRange);
        const dstRange = Dsl.#formatRange(p.destinationRange);
        return Dsl.parseSingleStatement(`await plurnk.copy(${JSON.stringify({
            from: srcRange === undefined ? p.source : { path: p.source, range: srcRange },
            to: dstRange === undefined ? p.destination : { path: p.destination, range: dstRange },
        })});`);
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.move requires destination");
        const srcRange = Dsl.#formatRange(p.lineRange);
        const dstRange = Dsl.#formatRange(p.destinationRange);
        return Dsl.parseSingleStatement(`await plurnk.move(${JSON.stringify({
            from: srcRange === undefined ? p.source : { path: p.source, range: srcRange },
            to: dstRange === undefined ? p.destination : { path: p.destination, range: dstRange },
        })});`);
    }

    static buildSend(p: OpSendParams): PlurnkStatement {
        return Dsl.parseSingleStatement(`await plurnk.send(${JSON.stringify({
            ...(p.recipient === undefined ? {} : { target: p.recipient }),
            ...(p.body === undefined || p.body.length === 0 ? {} : { text: p.body }),
        })});`);
    }

    static buildExec(p: OpExecParams): PlurnkStatement {
        const runtime = p.runtime ?? "sh";
        const bodyKey = runtime === "sh" ? "command" : (runtime === "js" || runtime === "python3" ? "code" : "body");
        return Dsl.parseSingleStatement(`await plurnk[${JSON.stringify(runtime)}](${JSON.stringify({
            ...(p.cwd === undefined ? {} : { [runtime === "sh" || runtime === "js" || runtime === "python3" ? "cwd" : "target"]: p.cwd }),
            ...(p.command === undefined || p.command.length === 0 ? {} : { [bodyKey]: p.command }),
        })});`);
    }
}
