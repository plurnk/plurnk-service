import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Knob } from "@plurnk/plurnk-meta";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { isRecord, type Notice } from "@plurnk/plurnk-contracts";
import { MimetypeClassifier } from "@plurnk/plurnk-schemes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db } from "./Db.ts";
import GitMembership from "./git-membership.ts";
import type { AdmissionProposal, AmbientMembers as Seam } from "./scheme-types.ts";

export const AUTO_ADD_KEY = "PLURNK_MEMBERS_AUTO_ADD";
// A candidate larger than this is listed and admitted by READ, never matched from disk.
const TEXT_BYTES_MAX = 1 << 20;

// {§membership-auto-add} — what the model can reach beyond membership while the knob is on, and the
// admission a read of it proposes: the Session's own `plurnk_members (add)` of that exact path, under the model's
// scope, a host effect the proposal lifecycle settles — by policy where nobody reviews, by the reviewer
// otherwise — announced by one `member_added` notice per file admitted.
export default class AmbientMembers {
    static enabled(environ: NodeJS.ProcessEnv = process.env): boolean {
        return Knob.flag(AUTO_ADD_KEY, environ);
    }

    // The files an accepted admission proposal admits, or null when the result proposes none.
    static admissionOf(result: unknown): readonly string[] | null {
        const attrs = isRecord(result) ? result.attrs : undefined;
        const admission = isRecord(attrs) ? attrs.admission : undefined;
        const files = isRecord(admission) ? admission.files : undefined;
        return Array.isArray(files) && files.every((file): file is string => typeof file === "string") ? files : null;
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
        const eligible = async (keys: readonly string[]): Promise<string[]> => {
            const out: string[] = [];
            for (const key of new Set(keys)) {
                if (await GitMembership.isAmbientCandidate(db, workspaceId, key, signal)) out.push(key);
            }
            return out;
        };
        // A key the members scope refused in this dispatch is proposed no further: the operation run again
        // after that refusal misses as a non-member, as it would with no universe at all.
        const refused = new Set<string>();
        return {
            candidates: (prefix) => GitMembership.ambientCandidates(db, workspaceId, prefix, signal),
            // The review material is the definition the acceptance admits, as a `plurnk_members (add)` body reads.
            propose: async (keys) => {
                const files = (await eligible(keys)).filter((key) => !refused.has(key));
                if (files.length === 0) return null;
                const proposal: AdmissionProposal = { status: 202, body: JSON.stringify({ files }), attrs: { effect: "host", admission: { files } } };
                return proposal;
            },
            admit: async (keys) => {
                const candidates = await eligible(keys);
                const admitted = [...await args.admit(candidates)];
                for (const key of candidates) if (!admitted.includes(key)) refused.add(key);
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
                const mimetype = MimetypeClassifier.normalizeAutoText(await args.mimetypes.detect({ path: key })) ?? "application/octet-stream";
                if (size > TEXT_BYTES_MAX || await MimetypeBinary.isBinaryMimetype(mimetype, args.mimetypes)) return { content: null, mimetype };
                try { return { content: await readFile(path, "utf8"), mimetype }; } catch { return null; }
            },
        };
    }
}
