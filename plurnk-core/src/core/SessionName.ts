import { SESSION_NAME } from "@plurnk/plurnk-contracts";
import { randomBytes } from "node:crypto";
import type { Db } from "./Db.ts";

export interface SessionNameClaim {
    id: number;
    name: string;
}

interface AutoSessionOptions {
    workspaceId: number;
    parentSessionId?: number;
    owner?: string;
    forkSnapshot?: boolean;
}

export class SessionNameConflictError extends Error {
    readonly sessionName: string;

    constructor(sessionName: string) {
        super(`Session '${sessionName}' already exists in this workspace.`);
        this.name = "SessionNameConflictError";
        this.sessionName = sessionName;
    }
}

export class SessionNameError extends Error {
    readonly sessionName: string;
    readonly code = "name-invalid";
    readonly recovery = "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit.";

    constructor(sessionName: string) {
        super(`Session name '${sessionName}' must match ${SESSION_NAME.source.slice(1, -1)}.`);
        this.name = "SessionNameError";
        this.sessionName = sessionName;
    }
}

// {§session-name-minting} Model-session minting only; the runtime actor
// ({§actor-boundary-self-hosting}) and generic URI ingestion have their own contracts.
export default class SessionName {
    static async forId(db: Db, sessionId: number): Promise<string> {
        const row = await db.session_name_by_id.get<{ name: string }>({ session_id: sessionId });
        if (row === undefined) throw new Error(`Session ${sessionId} does not exist.`);
        return row.name;
    }

    static assert(sessionName: string): string {
        if (!SESSION_NAME.test(sessionName)) throw new SessionNameError(sessionName);
        return sessionName;
    }

    static short(): string {
        return randomBytes(4).toString("hex");
    }

    // A generated name is not minted until this atomic claim creates its session.
    // Competing allocators retry only after losing the claim. {§session-auto-name}
    static async claimAuto(db: Db, options: AutoSessionOptions): Promise<SessionNameClaim> {
        const {
            workspaceId,
            parentSessionId,
            forkSnapshot = false,
        } = options;
        while (true) {
            const claimed = await db.session_name_claim.get<SessionNameClaim>({
                workspace_id: workspaceId,
                name: SessionName.assert(SessionName.short()),
                parent_session_id: parentSessionId ?? null,
                owner: options.owner ?? "_plurnk",
                fork_snapshot: forkSnapshot ? 1 : 0,
            });
            if (claimed !== undefined) return claimed;
        }
    }

    static async claimNamed(db: Db, name: string, options: AutoSessionOptions): Promise<SessionNameClaim> {
        const claimed = await db.session_name_claim.get<SessionNameClaim>({
            workspace_id: options.workspaceId,
            name: SessionName.assert(name),
            parent_session_id: options.parentSessionId ?? null,
            owner: options.owner ?? "_plurnk",
            fork_snapshot: options.forkSnapshot ? 1 : 0,
        });
        if (claimed === undefined) throw new SessionNameConflictError(name);
        return claimed;
    }
}
