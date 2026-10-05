import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";
import EmissionHead from "./EmissionHead.ts";

export type InternalTurnStatement = PlurnkStatement;

// {§statement-rendering} — core programs use the same serializer and admission parser.
export default class TurnOps {
    // {§emission-row} — each body as its head, an ellipsis marking the cut; a longer body's closer first says the statement
    // arrived whole, then names the source (#998: the ellipsis alone read as a truncated statement). Dispatch and
    // source evidence keep the original statements.
    static renderEmission(statements: readonly PlurnkStatement[], source: string): string {
        return statements.map((statement) => {
            const heading = PlurnkParser.heading(statement);
            const body = "body" in statement && statement.body !== null
                ? (typeof statement.body === "string" ? statement.body : statement.body.raw)
                : "";
            if (body.length === 0) return PlurnkParser.frame(heading, null);
            const { head: kept, cut } = EmissionHead.cut(body);
            if (!cut) return PlurnkParser.frame(heading, body);
            const head = `${kept.replace(/\r?\n$/u, "")}…`;
            return `${PlurnkParser.frame(heading, head)} <!-- display cut; the statement arrived whole: READ (${source}) for the full body -->`;
        }).join("\n\n");
    }

    static renderInternal(statements: readonly InternalTurnStatement[]): string {
        if (statements.length === 0 || statements.some((statement, index) => TurnDisposition.is(statement) && index !== statements.length - 1)) {
            throw new TypeError("An internal turnOps program must contain operations; WAIT, when present, must be last.");
        }
        return PlurnkParser.stringify(statements);
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
            if (item.kind === "text") {
                failures.push("Core programs contain only Operation Syntax OPs.");
                continue;
            }
            if (item.error.severity === "warning") continue;
            failures.push(item.error.message);
        }
        if (parsed.unparsedTail !== undefined) failures.push(parsed.unparsedTail.reason);
        if (failures.length > 0) {
            throw new SyntaxError(`Core generated invalid turnOps: ${failures.join("; ")}`);
        }
        return statements;
    }
}
