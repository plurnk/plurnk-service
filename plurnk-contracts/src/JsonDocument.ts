import { applyEdits, format, parseTree, type ParseError } from "jsonc-parser";

// Opt-in presentation, never a source rewrite. {§json-document-presentation}
export const formatJsonDocument = (content: string): string | undefined => {
    const errors: ParseError[] = [];
    const tree = parseTree(content, errors, { disallowComments: true, allowTrailingComma: false });
    if (tree === undefined || errors.length > 0) return undefined;
    return applyEdits(content, format(content, undefined, {
        insertSpaces: true,
        tabSize: 2,
        eol: "\n",
    }));
};
