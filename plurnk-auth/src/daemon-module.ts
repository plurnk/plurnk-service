// {§auth-oauth} {§module-contract} — this package's daemon module entry ({§module-lifecycle}):
// the optional OIDC / OAuth 2.1 resource server reads its settings from the assembled environment.
import Module from "./Module.ts";

export default (): Module => Module.create();
