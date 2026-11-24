import type {
    PlurnkStatement,
    Position,
    RuntimeTag,
} from "@plurnk/plurnk-contracts";
import type { ParseOptions, toMatcherBody } from "../OptionCoercion.ts";

export interface LoweringContext {
    readonly tier: "model" | "statements";
    readonly options: ParseOptions;
    readonly executorSpellings: ReadonlyMap<string, RuntimeTag>;
    readonly position: () => Position;
    readonly defaultAside: () => string | null;
    readonly emitStatement: <T extends PlurnkStatement>(statement: T) => T;
    readonly checkKeys: (
        obj: Record<string, unknown>,
        allowed: ReadonlySet<string>,
        opLabel: string,
        recovery: string,
        pos: Position,
    ) => void;
    readonly resolveAside: (argObj: Record<string, unknown> | null) => string | null;
    readonly resolveMatcher: (value: unknown, op: string, pos: Position) => ReturnType<typeof toMatcherBody>;
    readonly coerceBodyString: (value: unknown) => string;
    readonly coerceArgString: (args: readonly unknown[], index: number) => string;
}
