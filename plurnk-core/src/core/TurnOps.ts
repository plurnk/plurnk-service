import { TurnDisposition } from "@plurnk/plurnk-contracts";
import { PlurnkParser, type ParseOptions } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";

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
    // Trial (#1073): a replayed turn shows its NOTEs, and only those whose log row is still visible, so a
    // KILL of a NOTE row takes the NOTE out of the replay too.
    static renderHistory(source: string, executors: readonly string[], visibleNoteBodies?: readonly string[]): string {
        const remaining = new Map<string, number>();
        for (const body of visibleNoteBodies ?? []) remaining.set(body, (remaining.get(body) ?? 0) + 1);
        return TurnOps.renderEmission(TurnOps.parseInternal(source, { executors }).filter((statement) => {
            if (statement.op !== "NOTE") return false;
            if (visibleNoteBodies === undefined) return true;
            const body = statement.body ?? "";
            const left = remaining.get(body) ?? 0;
            if (left === 0) return false;
            remaining.set(body, left - 1);
            return true;
        }));
    }

    // Trial (#1073): the text a NOTE occupies in its replayed turn, for the legend's weight.
    static noteFence(body: string): string { return PlurnkParser.frame("NOTE", body); }

    // Trial (#1073): the NOTE bodies a frozen program replays, in order; a NOTE admitted from reasoning
    // is not among them and keeps its ordinary row.
    static noteBodies(source: string, executors: readonly string[]): string[] {
        return TurnOps.parseInternal(source, { executors }).filter((statement) => statement.op === "NOTE").map((statement) => statement.body ?? "");
    }

    static renderInternal(statements: readonly InternalTurnStatement[]): string {
        if (statements.length === 0 || statements.some((statement, index) => TurnDisposition.is(statement) && index !== statements.length - 1)) {
            throw new TypeError("An internal turnOps program must contain operations; WAIT, when present, must be last.");
        }
        return PlurnkParser.stringify(statements);
    }

    static parseInternal(source: string, options?: ParseOptions): PlurnkStatement[] {
        const parsed = PlurnkParser.parse(source, options);
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
