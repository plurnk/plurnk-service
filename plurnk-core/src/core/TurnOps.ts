import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { schemeNameOf } from "./plurnk-uri.ts";

export type InternalTurnStatement = PlurnkStatement;

// {§statement-rendering} — core programs use the same serializer and admission parser.
export default class TurnOps {
    // {§emission-row} — the frozen projection is the admitted program, canonical and whole; the wire derives
    // what the model is shown from it ({§packet-wire-envelope}).
    static renderEmission(statements: readonly PlurnkStatement[]): string {
        return statements.map((statement) => {
            const body = "body" in statement && statement.body !== null
                ? (typeof statement.body === "string" ? statement.body : statement.body.raw)
                : "";
            return PlurnkParser.frame(PlurnkParser.heading(statement), body.length === 0 ? null : body);
        }).join("\n\n");
    }

    // {§emission-history} — select whole operations from the frozen program, never from its bodies.
    static renderHistory(source: string): string {
        return TurnOps.renderEmission(TurnOps.parseInternal(source).filter((statement) =>
            statement.op !== "NOTE" && !(statement.op === "KILL" && schemeNameOf(statement.target) === "log")));
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
