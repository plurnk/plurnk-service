import { diffLines } from "diff";

// §edit-result-render — the resulting span: the changed region of `updated` (relative to
// `original`), line-numbered (1-indexed), with `context` lines of padding above
// and below. Diff to find the changed lines, render their post-edit state.
// Shared by EDIT result rendering (`_entry-ops`) and the environment-delta
// materialization (`Engine`, §env-delta) — both show "the edited area as it is now."
export const editedSpan = (original: string, updated: string, context = 2): string => {
    const rows: { text: string; changed: boolean }[] = [];
    for (const part of diffLines(original, updated)) {
        if (part.removed) continue;  // removed lines aren't in the new content
        const ls = part.value.split("\n");
        if (ls.length > 1 && ls[ls.length - 1] === "") ls.pop();  // drop trailing-newline artifact
        for (const t of ls) rows.push({ text: t, changed: part.added === true });
    }
    let lo = -1, hi = -1;
    for (let i = 0; i < rows.length; i++) if (rows[i].changed) { if (lo < 0) lo = i; hi = i; }
    if (lo < 0) { lo = 0; hi = rows.length - 1; }  // no added hunk (defensive) → whole
    const start = Math.max(0, lo - context);
    const end = Math.min(rows.length - 1, hi + context);
    return rows.slice(start, end + 1).map((r, i) => `${start + i + 1}:${r.text}`).join("\n");
};
