// Build-time drift guard (§61). The framework bakes its own TelemetryEvent copy
// (TelemetryEvent.ts) so it carries no RUNTIME grammar dependency — but the
// grammar owns the contract, so this copy must stay structurally identical to it.
// Grammar is imported HERE ONLY, as a devDependency, never in shipped code; if the
// grammar's schema changes shape, the assignability assertions below fail `tsc`
// (test:lint) and the baked copy must be regenerated. No runtime assertions — the
// guarantee is entirely at type-check time.
import { describe, it } from "node:test";
import type { TelemetryEvent as Baked, ContentOffset as BakedCO, LogCoordinate as BakedLC } from "./TelemetryEvent.ts";
import type { TelemetryEvent as Contract, ContentOffset as ContractCO, LogCoordinate as ContractLC } from "@plurnk/plurnk-grammar";

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

// Fail tsc if the baked copy and the grammar contract diverge in either direction.
type _event = Expect<MutuallyAssignable<Baked, Contract>>;
type _contentOffset = Expect<MutuallyAssignable<BakedCO, ContractCO>>;
type _logCoordinate = Expect<MutuallyAssignable<BakedLC, ContractLC>>;

describe("TelemetryEvent drift guard", () => {
    it("baked copy matches @plurnk/plurnk-grammar at build time (see the type assertions above)", () => {
        // The real check is compile-time (the `Expect<...>` types); this keeps the
        // file in the node:test run and documents intent.
    });
});
