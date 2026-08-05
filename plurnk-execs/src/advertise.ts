import type { ExecInfo, ExecRegistry } from "./types.ts";

/**
 * @deprecated Frozen 1.x compatibility helper. Hosts own executable admission
 * and presentation through their current composition ({§executor-advertise-compat}).
 */
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
