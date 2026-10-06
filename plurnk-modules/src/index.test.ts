// {§module-contract} {§module-seam-slices} — the contract is abstractions only, and its slices compose
// as specified. The `Assignable` witnesses are checked by `tsc --noEmit` (test:lint).
import test from "node:test";
import { strict as assert } from "node:assert";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import * as contract from "./index.ts";
import type { DaemonModule, FunctionalityAdapter, FunctionalitySeam, ModuleSetupSeam } from "./index.ts";

type Assignable<From, To> = [From] extends [To] ? true : false;

// Stand-ins for what other families own: a prepared runtime and a scheme facet.
interface Runtime { readonly runtime: string }
interface Facet { claims(pathname: string): boolean }
type HostSeam = ModuleSetupSeam & FunctionalitySeam<Runtime, Facet>;
type NarrowSetup = Pick<ModuleSetupSeam, "readWorkspaceEnvironment"> & FunctionalitySeam;
type NarrowStart = Pick<ApplicationPort, "listWorkspaces">;

test("the module contract holds only abstractions: nothing of it exists at runtime", () => {
    assert.deepEqual(Object.keys(contract), []);
});

test("a module typed by the slices it uses is accepted by a host that offers more", () => {
    const accepted: Assignable<DaemonModule<NarrowSetup, NarrowStart>, DaemonModule<HostSeam, ApplicationPort>> = true;
    assert.equal(accepted, true);
});

test("an adapter that prepares no runtime and exposes no facet fits every family's adapter type", () => {
    const fits: Assignable<FunctionalityAdapter, FunctionalityAdapter<Runtime, Facet>> = true;
    assert.equal(fits, true);
});

test("what a family owns is not in the base slice", () => {
    const schemes: Assignable<ModuleSetupSeam, { registerScheme(name: string, handler: object): Promise<void> }> = false;
    const plugins: Assignable<ModuleSetupSeam, { readWorkspacePlugins(workspaceId: number): Promise<unknown> }> = false;
    assert.deepEqual([schemes, plugins], [false, false]);
});
