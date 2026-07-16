// Ambient GIT_* is scrubbed at the one boundary that spawns git — post-#461 that boundary is
// the PLURNK_SERVICE_GIT_NATIVE=1 arm (GitMembership/GitState routing to system git) plus the
// intg git fixtures; the default GitIso backend never spawns and never reads env, so it needs
// none of this. A process launched from a git hook inherits GIT_DIR — ABSOLUTE in a worktree
// checkout — which retargets every child git at the enclosing repo regardless of cwd (#401:
// the pre-push drill's fixture seeds stacked onto lane branches and deleted tracked files; a
// hook-launched daemon would misread project git state the same way). Git resolves everything
// it needs from cwd; project state binds to the session's project_root, never to whoever
// spawned us.
//
// AND the machine's GLOBAL/SYSTEM config is severed (#428): a sandbox git op that reads
// ~/.gitconfig picks up the user's `core.hooksPath` — the dotfiles hook symlinked from
// ~/.git/templates/hooks — and a probe overwrote that global hook with `exit 1`, silently failing
// every leaf repo's push for a day (a recurrence of #401's class via the global-config vector).
// Pointing GIT_CONFIG_GLOBAL/SYSTEM at /dev/null means NO git op we spawn can read, invoke, or
// write the machine's global hooks/config — membership is repo-scoped and machine-deterministic,
// and a sandbox can never escape to ~/.git or ~/.gitconfig. (Our reads — ls-files/rev-parse — need
// no user identity; `--exclude-standard` honors the repo's own .gitignore, never a global one.)
export const hermeticGitEnv = (): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
});
