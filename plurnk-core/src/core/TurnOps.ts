import { TurnDisposition } from "@plurnk/plurnk-contracts";
import {
    PlurnkParseError,
    PlurnkParser,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";

export type InternalTurnStatement = PlurnkStatement;

// {§statement-rendering} — core programs use the same serializer and admission parser.
export default class TurnOps {
    static renderInternal(statements: readonly InternalTurnStatement[]): string {
        if (statements[0]?.op !== "PLAN" || statements.filter((statement) => TurnDisposition.is(statement)).length !== 1) {
            throw new TypeError("An internal turnOps program must begin with PLAN and contain one disposition.");
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
            if (item.kind === "text" && item.text.trim().length === 0) continue;
            if (item.kind === "error" && item.error.severity === "warning") continue;
            const error = item.kind === "error" ? item.error : null;
            failures.push(error instanceof PlurnkParseError ? error.message : "unparsed text");
        }
        if (parsed.unparsedTail !== undefined) failures.push(parsed.unparsedTail.reason);
        if (failures.length > 0) {
            throw new SyntaxError(`Core generated invalid turnOps: ${failures.join("; ")}`);
        }
        if (statements[0]?.op !== "PLAN" || statements.filter((statement) => TurnDisposition.is(statement)).length !== 1) {
            throw new SyntaxError("Core generated turnOps without a leading PLAN and one disposition.");
        }
        return statements;
    }
}
