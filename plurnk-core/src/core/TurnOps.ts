import { TurnDisposition } from "@plurnk/plurnk-contracts";
import {
    PlurnkParser,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";

export type InternalTurnStatement = PlurnkStatement;

// {§statement-rendering} — core programs use the same serializer and admission parser.
export default class TurnOps {
    static renderInternal(statements: readonly InternalTurnStatement[]): string {
        if (statements.length === 0 || statements.some((statement, index) => TurnDisposition.is(statement) && index !== statements.length - 1)) {
            throw new TypeError("An internal turnOps program must contain operations; TASK, when present, must be last.");
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
