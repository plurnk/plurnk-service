import { buildJsonOutline } from "./buildJsonOutline.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { outlineLineFor } from "./query.ts";
import type { MimeSymbol } from "./types.ts";

type SymbolSource = () => readonly MimeSymbol[] | Promise<readonly MimeSymbol[]>;

// One default deep-XML projection for materialization and XPath
// ({§mimetype-handler-contract}).
export async function projectDeepXml(
    deepJson: unknown,
    symbols: SymbolSource,
): Promise<string> {
    if (deepJson !== null && deepJson !== undefined) return projectJsonToXml(deepJson);
    const outline = buildJsonOutline(await symbols());
    if (Object.keys(outline).length === 0) return "";
    return projectJsonToXml(outline, "root", outlineLineFor(outline));
}
