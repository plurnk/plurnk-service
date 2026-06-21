// #240 — the shared teaching-line shape for the System Tools (exec tags) + System Schemes
// directories: a terse `* <oneliner>` plus an optional pull-doc link, rendered IDENTICALLY for
// execs and schemes. The example self-documents its tag/scheme, so no service-added prefix.
// `* ` bullets + bare op forms match the packet's list/op rendering (no `- `, no backticks).
export const teachingLine = (oneliner: string, docName: string, hasDoc: boolean): string =>
    `* ${oneliner}${hasDoc ? ` (docs: plurnk://docs/${docName}.md)` : ""}`;
