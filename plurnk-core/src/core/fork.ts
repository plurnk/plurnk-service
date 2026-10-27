// Fork a session — branch the log, share the workspace (SPEC {§machine-processes}).
// The branch's claimed row is the fork: sessions_fork_copies_history copies the parent's
// history inside that INSERT ({§machine-processes}, fork.sql).

import type { Db } from "./Db.ts";
import SessionName from "./SessionName.ts";

export default class Fork {
    static async fork(db: Db, parentSessionId: number, name: string | undefined): Promise<number> {
        const parent = await db.session_get.get<{ workspace_id: number }>({ id: parentSessionId });
        if (parent === undefined) throw new Error(`fork: session ${parentSessionId} not found`);
        // {§execution-output-identity} The same allocator serves addressless WORK and FORK.
        const options = { workspaceId: parent.workspace_id, parentSessionId, forkSnapshot: true } as const;
        const branch = name === undefined
            ? await SessionName.claimAuto(db, options)
            : await SessionName.claimNamed(db, name, options);
        return branch.id;
    }
}
