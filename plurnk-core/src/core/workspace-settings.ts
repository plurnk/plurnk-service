// {§operator-config} — a workspace's client-chosen open context: the per-workspace overrides a client
// user legitimately sets at workspace.create, read at turn-0 with precedence over env.
// filesItems REPLACES the env value; the other knobs compose per their own tags.
// Storage is a JSON bag on workspaces.settings.

import type { Db } from "./Db.ts";
import { isRecord, PROPOSAL_POLICIES, type ProposalPolicy } from "@plurnk/plurnk-contracts";
import FileCreationPolicy, { type FileCreateScope } from "./file-creation-policy.ts";

export type StandingPermission = "allow_always" | "reject_always";

const isProposalPolicy = (value: unknown): value is ProposalPolicy =>
    typeof value === "string" && (PROPOSAL_POLICIES as readonly string[]).includes(value);

const isStandingPermission = (value: unknown): value is StandingPermission =>
    value === "allow_always" || value === "reject_always";

export type WorkspaceOpenContext = {
    filesItems: number | null; // {§operator-config-workspace-settings} — replace env; null = unset
    maxCommands: number | null; // {§operator-config-workspace-settings} — min() with env; null = unset
    git: boolean | null;       // {§operator-config-workspace-settings} — env AND workspace; null = unset
    fileCreateScope: FileCreateScope | null; // {§operator-config-workspace-settings}
    membersModelScope: FileCreateScope | null; // {§tools-resource-materialization}
    client: string | null;     // {§emission-admission} — workspace-stable frontend id; null = unset
    proposalPolicy: ProposalPolicy | null;
    permissions: Readonly<Record<string, StandingPermission>>;
};

export default class WorkspaceSettings {
    static parse(raw: string, workspaceId: number): WorkspaceOpenContext {
        let bag: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!isRecord(parsed)) throw new TypeError("Workspace settings must be a JSON object.");
            bag = parsed;
        } catch (cause) {
            throw new Error(`Workspace ${workspaceId} has invalid persisted settings.`, { cause });
        }
        const filesItems = typeof bag.filesItems === "number" ? bag.filesItems : null;
        const maxCommands = typeof bag.maxCommands === "number" ? bag.maxCommands : null;
        const git = typeof bag.git === "boolean" ? bag.git : null;
        const fileCreateScope = bag.fileCreateScope === undefined
            ? null
            : FileCreationPolicy.parse(bag.fileCreateScope, "settings.fileCreateScope");
        const membersModelScope = bag.membersModelScope === undefined
            ? null
            : FileCreationPolicy.parse(bag.membersModelScope, "settings.membersModelScope");
        const client = typeof bag.client === "string" ? bag.client : null;
        let proposalPolicy: ProposalPolicy | null = null;
        if (bag.proposalPolicy !== undefined && bag.proposalPolicy !== null) {
            if (!isProposalPolicy(bag.proposalPolicy)) {
                throw new Error(`Workspace ${workspaceId} has invalid persisted proposal policy.`);
            }
            proposalPolicy = bag.proposalPolicy;
        }
        const permissions: Record<string, StandingPermission> = {};
        if (bag.permissions !== undefined) {
            if (!isRecord(bag.permissions)) {
                throw new Error(`Workspace ${workspaceId} has invalid persisted permissions.`);
            }
            for (const [key, value] of Object.entries(bag.permissions)) {
                if (key.length === 0 || !isStandingPermission(value)) {
                    throw new Error(`Workspace ${workspaceId} has invalid persisted permissions.`);
                }
                permissions[key] = value;
            }
        }
        return {
            filesItems,
            maxCommands,
            git,
            fileCreateScope,
            membersModelScope,
            client,
            proposalPolicy,
            permissions: Object.freeze(permissions),
        };
    }

    // The workspace's open-context bag. Absent/unset fields read as null / {}. A malformed
    // bag never reaches here — workspace.create validates before persisting.
    static async read(db: Db, workspaceId: number): Promise<WorkspaceOpenContext> {
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error(`Workspace ${workspaceId} does not exist while reading its settings.`);
        return WorkspaceSettings.parse(row.settings, workspaceId);
    }

}
