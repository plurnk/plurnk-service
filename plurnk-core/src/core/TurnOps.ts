import {
    PlurnkParseError,
    PlurnkParser,
    PlanValue,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";

export type InternalTurnStatement = PlurnkStatement;

const renderBody = (statement: InternalTurnStatement): string | null => {
    if (statement.op === "PLAN") return PlanValue.stringify(statement.body);
    if (statement.body === null) return null;
    if (typeof statement.body === "string") return statement.body;
    if ("raw" in statement.body) return statement.body.raw;
    const marker = statement.body.lineMarker;
    return marker === null
        ? statement.body.target.raw
        : `${statement.body.target.raw} <${marker.marks.join(",")}>`;
};

// Core-authored turns are programs, not synthetic result rows. This formatter
// owns the deliberately small statement alphabet used by initialization and
// overflow recovery; its output is reparsed before admission so the parser,
// rather than constructed AST objects, remains the executable authority.
export default class TurnOps {
    static renderInternal(statements: readonly InternalTurnStatement[]): string {
        if (statements[0]?.op !== "PLAN" || statements.at(-1)?.op !== "SEND") {
            throw new TypeError("An internal turnOps program must begin with PLAN and end with SEND.");
        }
        const delimiter = statements[0].delimiter || "0";
        return statements.map((statement, index) => {
            const heading = statement.op === "PLAN"
                ? `# PLAN${delimiter}`
                : `## ${statement.op}${delimiter}`;
            const modifiers: string[] = [];
            if (statement.signal !== null) {
                modifiers.push(`[${Array.isArray(statement.signal) ? statement.signal.join(",") : statement.signal}]`);
            }
            if (statement.target !== null) modifiers.push(`(${statement.target.raw})`);
            if (statement.lineMarker !== null) modifiers.push(`<${statement.lineMarker.marks.join(",")}>`);
            if (statement.annotation !== null) modifiers.push(`<!-- ${statement.annotation} -->`);
            const header = modifiers.length === 0 ? heading : `${heading} ${modifiers.join(" ")}`;
            const body = renderBody(statement);
            const boundaryPadding = body?.endsWith("\n") === true && index < statements.length - 1
                ? "\n"
                : "";
            return body === null ? header : `${header}\n${body}${boundaryPadding}`;
        }).join("\n");
    }

    static parseInternal(source: string): PlurnkStatement[] {
        const parsed = PlurnkParser.parse(source);
        const statements: PlurnkStatement[] = [];
        const failures: string[] = [];
        for (const item of parsed.items) {
            if (item.kind === "statement") {
                statements.push(item.statement);
                continue;
            }
            if (item.kind === "text" && item.text.trim().length === 0) continue;
            const error = item.kind === "error" ? item.error : null;
            failures.push(error instanceof PlurnkParseError ? error.message : "unparsed text");
        }
        if (parsed.unparsedTail !== undefined) failures.push(parsed.unparsedTail.reason);
        if (failures.length > 0) {
            throw new SyntaxError(`Core generated invalid turnOps: ${failures.join("; ")}`);
        }
        if (statements[0]?.op !== "PLAN" || statements.at(-1)?.op !== "SEND") {
            throw new SyntaxError("Core generated turnOps without a PLAN…SEND boundary.");
        }
        return statements;
    }
}
