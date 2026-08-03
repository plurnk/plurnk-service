const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
const MISSING_SPECIFIER = /^Cannot find (?:package|module) (['"])([^'"]+)\1(?: imported from|\nRequire stack:|$)/;

// Node exposes the unresolved specifier only in its primary resolution
// message; exact classification enforces {§mimetype-artifact-absence}.
export function isExactModuleAbsent(error: unknown, specifier: string): boolean {
    if (typeof error !== "object" || error === null) return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code !== "string" || !MODULE_NOT_FOUND_CODES.has(code)) return false;
    if (typeof message !== "string") return false;
    return MISSING_SPECIFIER.exec(message)?.[2] === specifier;
}
