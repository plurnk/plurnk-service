// {§agui-client-types} The contracts a client of this interface consumes, runtime-neutral: the state its
// STATE_SNAPSHOT and STATE_DELTA events carry, and the outcome a management action reports. A browser
// type-checks this entry with DOM libraries and no Node globals; the server module is the package root.
export type {
    ActionOutcome,
    AguiBudgetState,
    AguiDescendant,
    AguiDerivationActivity,
    AguiLifecycle,
    AguiPlusState,
    AguiSpendState,
    AguiStatusState,
    AguiWorkspaceState,
} from "./AguiPlus.ts";
