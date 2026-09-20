import { Results, type RepresentationPreparationRequest, type RepresentationPreparationResult, type SchemeCtx } from "@plurnk/plurnk-schemes";

type RuleList = (workspaceId: number) => Promise<readonly { alias: string; state: string; [key: string]: unknown }[]>;

// The readable rule resources, `schedule:///rules/<alias>`; an occurrence is a message, never a wait.
export default class ScheduleResources {
    readonly #list: RuleList;

    constructor(list: RuleList) {
        this.#list = list;
    }

    claims(pathname: string): boolean {
        return /^\/rules(?:\/|$)/u.test(pathname);
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        if (request.authority !== "") return Results.failure("schedule:resource", "authority-invalid", 400, "Schedule resources use an empty authority.");
        const { pathname } = request;
        const content = (await this.#list(ctx.workspaceId)).find((rule) => pathname === `/rules/${encodeURIComponent(rule.alias)}`);
        if (content === undefined) return Results.failure("schedule:resource", "not-found", 404, "The schedule resource does not exist.");
        const result = await ctx.entries.write(pathname, { channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } } });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }
}
