// Test fixture builders route clean parameters through the contracts-owned
// statement parser so Core receives production AST shapes. {§tier-entrypoints}
// {§methods-op-mirror}

import { PLURNK_OPS, PlurnkParser } from "@plurnk/plurnk-contracts";
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
    // Use the canonical lane unless the body contains a heading in that lane;
    // then deterministically choose the first lane that leaves the body opaque.
    static #suffixFor(body: string): string {
        const h2Ops = PLURNK_OPS.filter((op) => op !== "PLAN").join("|");
        for (let lane = 1; ; lane++) {
            const suffix = String(lane);
            const structuralHeading = new RegExp(`^(?:# PLAN|## (?:${h2Ops}))${suffix}(?=$|[ \\t])`, "m");
            if (!structuralHeading.test(body)) return suffix;
        }
    }

    static #formatTags(tags: string[] | undefined): string {
        if (tags === undefined || tags.length === 0) return "";
        return `[${tags.join(",")}]`;
    }

    static #formatAppliedTags(tags: string[] | undefined): string {
        if (tags === undefined || tags.length === 0) return "";
        return `[${tags.map((tag) => `+${tag}`).join(",")}]`;
    }

    static #formatLineMarker(lm: LineMarker | undefined): string {
        if (lm === undefined || lm === null) return "";
        return `<${lm.marks.join(",")}>`;
    }

    static #formatPath(path: string | undefined): string {
        if (path === undefined) return "";
        return `(${path})`;
    }

    // Build one statement. `signal` is the already-formatted signal payload —
    // additive tags for producer ops, selectors/changes for curation, a single number for SEND (`[200]`),
    // a single runtime tag for EXEC (`[node]`).
    static #buildStatement({
        op, signal, target, lineMarker, body,
    }: {
        op: string;
        signal: string;
        target: string;
        lineMarker: string;
        body: string;
    }): string {
        const suffix = Dsl.#suffixFor(body);
        const modifiers = [signal, target, lineMarker].filter((value) => value.length > 0).join(" ");
        const heading = `## ${op}${suffix}${modifiers.length > 0 ? ` ${modifiers}` : ""}`;
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
            signal: Dsl.#formatAppliedTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.content ?? "",
        }));
    }

    static buildRead(p: OpWithMatcher): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "READ",
            signal: Dsl.#formatAppliedTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildFind(p: { scope: string; matcher?: string; tags?: string[]; lineRange?: LineMarker }): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "FIND",
            signal: Dsl.#formatAppliedTags(p.tags),
            target: Dsl.#formatPath(p.scope),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.matcher ?? "",
        }));
    }

    static buildOpen(p: OpCuration): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "OPEN",
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: "",
            body: p.matcher ?? "",
        }));
    }

    static buildFold(p: OpCuration): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "FOLD",
            signal: Dsl.#formatTags(p.tags),
            target: Dsl.#formatPath(p.target),
            lineMarker: "",
            body: p.matcher ?? "",
        }));
    }

    static buildCopy(p: OpCopyMoveParams): PlurnkStatement {
        if (p.destination === undefined) throw new Error("op.copy requires destination");
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "COPY",
            signal: Dsl.#formatAppliedTags(p.tags),
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static buildMove(p: OpCopyMoveParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "MOVE",
            signal: Dsl.#formatAppliedTags(p.tags),
            target: Dsl.#formatPath(p.source),
            lineMarker: Dsl.#formatLineMarker(p.lineRange),
            body: p.destination === undefined
                ? ""
                : `${p.destination}${Dsl.#formatLineMarker(p.destinationRange)}`,
        }));
    }

    static buildSend(p: OpSendParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "SEND",
            signal: `[${p.status}]`,
            target: p.recipient !== undefined ? Dsl.#formatPath(p.recipient) : "",
            lineMarker: "",
            body: p.body ?? "",
        }));
    }

    static buildExec(p: OpExecParams): PlurnkStatement {
        return Dsl.parseSingleStatement(Dsl.#buildStatement({
            op: "EXEC",
            signal: p.runtime !== undefined ? `[${p.runtime}]` : "",
            target: p.cwd !== undefined ? Dsl.#formatPath(p.cwd) : "",
            lineMarker: "",
            body: p.command ?? "",
        }));
    }
}
