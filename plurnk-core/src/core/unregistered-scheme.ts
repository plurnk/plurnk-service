// {§unregistered-scheme-recovery} {§diagnostic-observation} — an unregistered scheme's refusal names the
// schemes this workspace registers; it never rebuilds the address into another operation.
export function unregisteredSchemeRecovery(registered: readonly string[]): string {
    return `Registered schemes: ${registered.join(", ")}.`;
}
