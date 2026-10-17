import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Notice } from "@plurnk/plurnk-contracts";
import { MimetypeBinary } from "../content/index.ts";
import type { Db } from "./Db.ts";
import GitMembership from "./git-membership.ts";
import ProposalPolicies from "./ProposalPolicies.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import type { AmbientMembers as Seam } from "./scheme-types.ts";

export const AUTO_ADD_KEY = "PLURNK_MEMBERS_AUTO_ADD";
// A candidate larger than this is listed and admitted by READ, never matched from disk.
const TEXT_BYTES_MAX = 1 << 20;

// {§membership-auto-add} — what the model can reach beyond membership while the knob is on, and the
// admission that follows a read of it: the Worker's own `members (add)` of that exact path, under the
// model's scope, announced by one `member_added` notice per file.
export default class AmbientMembers {
    static enabled(environ: NodeJS.ProcessEnv = process.env): boolean {
        return Knob.flag(AUTO_ADD_KEY, environ);
    }

    // An admission a read earns settles without a person, so it exists only where the Worker's own
    // `members (add)` — a host effect — would: the effect policy admits it, or the server accepts proposals.
    // {§configuration-repair-path} An unreadable policy cannot say so: no read admits, and the policy's own
    // reader reports the value where a proposal meets it.
    static unattended(): boolean {
        try {
            return EffectPolicy.decide("host") === "auto" || ProposalPolicies.read() === "accept";
        } catch (cause) {
            if (cause instanceof ConfigurationError) return false;
            throw cause;
        }
    }

    static seam(args: {
        db: Db;
        workspaceId: number;
        signal: AbortSignal | undefined;
        mimetypes: Mimetypes | undefined;
        admit: (files: readonly string[]) => Promise<readonly string[]>;
        notice: (notice: Notice) => void;
    }): Seam {
        const { db, workspaceId, signal } = args;
        return {
            candidates: (prefix) => GitMembership.ambientCandidates(db, workspaceId, prefix, signal),
            admit: async (keys) => {
                const eligible: string[] = [];
                for (const key of new Set(keys)) {
                    if (await GitMembership.isAmbientCandidate(db, workspaceId, key, signal)) eligible.push(key);
                }
                if (eligible.length === 0) return [];
                const admitted = [...await args.admit(eligible)];
                for (const key of admitted) {
                    args.notice({ source: "scheme:file", kind: "member_added", level: "warn", message: `'${key}' is now a member of this workspace.` });
                }
                return admitted;
            },
            text: async (key) => {
                const root = await GitMembership.workspaceRoot(db, workspaceId);
                if (root === null || args.mimetypes === undefined) return null;
                const path = resolve(root, key);
                let size: number;
                try { size = (await stat(path)).size; } catch { return null; }
                const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await args.mimetypes.detect({ path: key })) ?? "application/octet-stream";
                if (size > TEXT_BYTES_MAX || await MimetypeBinary.isBinaryMimetype(mimetype, args.mimetypes)) return { content: null, mimetype };
                try { return { content: await readFile(path, "utf8"), mimetype }; } catch { return null; }
            },
        };
    }
}
