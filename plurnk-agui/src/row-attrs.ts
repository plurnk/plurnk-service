// {§agui-plurnk-metadata} A row's attributes that hold a body: a file write's text before and after, its diff and its edit
// receipt, which its result holds, and a statement's body, which its call's arguments hold.
const BODY_ATTRS: ReadonlySet<string> = new Set(["original", "patched", "patchedBytes", "patch", "editReceipt", "body", "inputBody"]);

// {§agui-plurnk-metadata} A row's attributes without the bodies they hold, on every part and projection that carries them.
export const withoutBodies = (attrs: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(attrs).filter(([key]) => !BODY_ATTRS.has(key)));
