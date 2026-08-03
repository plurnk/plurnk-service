import type { ExecInfo, ExecRegistry } from "./types.ts";

// Legacy public capability contributor; reconciliation is tracked in #103.
export default class Advertise {
    static readonly NO_EXECS_NOTICE = "No EXEC operations permitted";

    static contribute(
        registry: ExecRegistry,
        isPermitted: (tag: string) => boolean,
    ): { permitted: ExecInfo[]; notice: string | null } {
        const permitted = [...registry.values()].filter(({ runtime }) => isPermitted(runtime));
        return { permitted, notice: permitted.length === 0 ? Advertise.NO_EXECS_NOTICE : null };
    }
}
