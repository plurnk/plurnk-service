import { Validator, type SessionOwner } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import Results, { OperationFailureError } from "./results.ts";

type OwnerRow = { address: string; tools: string; interactive: number };

// {§session-ownership} Presence is deliberately absent: disconnect does not erase capabilities.
export default class SessionOwners {
    static async register(db: Db, workspaceId: number, owner: SessionOwner): Promise<void> {
        const exact = Validator.assertSessionOwner(owner);
        if (exact.address === "_plurnk") throw new OperationFailureError(Results.failure(
            "session:owner", "runtime-owner-reserved", 409, "The runtime owner cannot be registered by a client.",
        ));
        await db.session_owner_register.run({
            workspace_id: workspaceId, address: exact.address, tools: JSON.stringify(exact.tools), interactive: exact.interactive ? 1 : 0,
        });
    }

    // {§connection-lifecycle} A person becomes an owner by starting a session, with no tools until a
    // client registers them.
    static async admit(db: Db, workspaceId: number, address: string): Promise<void> {
        const exact = Validator.assertSessionOwner({ address, tools: [], interactive: false });
        await db.session_owner_admit.run({ workspace_id: workspaceId, address: exact.address });
    }

    static #project(row: OwnerRow | undefined, identity: string): SessionOwner {
        if (row === undefined) throw new Error(`${identity} has no owner.`);
        return Validator.assertSessionOwner({ address: row.address, tools: JSON.parse(row.tools) as unknown, interactive: row.interactive === 1 });
    }

    static async read(db: Db, sessionId: number): Promise<SessionOwner> {
        return SessionOwners.#project(await db.session_owner_read.get<OwnerRow>({ session_id: sessionId }), `Session ${sessionId}`);
    }

    static async forLoop(db: Db, loopId: number): Promise<SessionOwner> {
        return SessionOwners.#project(await db.session_owner_for_loop.get<OwnerRow>({ loop_id: loopId }), `Loop ${loopId}`);
    }

    // {§session-ownership} A person attends the loop's owner: a park only a person can end may wait for it.
    static async interactive(db: Db, loopId: number): Promise<boolean> {
        return (await SessionOwners.forLoop(db, loopId)).interactive;
    }

    // {§session-ownership} Only a person answers: the owner must be attended and declare the tool.
    static receives(owner: SessionOwner, toolName: string): boolean {
        return owner.interactive && owner.tools.includes(toolName);
    }

    static async registered(db: Db, workspaceId: number, address: string): Promise<SessionOwner> {
        const row = await db.session_owner_registered.get<OwnerRow>({ workspace_id: workspaceId, address });
        if (row === undefined) throw new OperationFailureError(Results.failure(
            "session:owner", "owner-not-found", 404, `Owner '${address}' is not registered in workspace ${workspaceId}.`,
            {}, { workspaceId, owner: address },
        ));
        return SessionOwners.#project(row, `Owner '${address}'`);
    }

    static async claim(db: Db, workspaceId: number, sessionId: number, owner: string): Promise<SessionOwner> {
        await SessionOwners.registered(db, workspaceId, owner);
        await db.session_owner_claim.run({ workspace_id: workspaceId, session_id: sessionId, owner });
        await db.session_owner_claim_interactions.run({ workspace_id: workspaceId, session_id: sessionId, owner });
        return SessionOwners.read(db, sessionId);
    }
}
