// Ambient GIT_* is scrubbed at the one boundary that spawns git. A process launched from a git
// hook inherits GIT_DIR — ABSOLUTE in a worktree checkout — which retargets every child git at
// the enclosing repo regardless of cwd (#401: the pre-push drill's fixture seeds stacked onto
// lane branches and deleted tracked files; a hook-launched daemon would misread project git
// state the same way). Git resolves everything it needs from cwd; project state binds to the
// session's project_root, never to whoever spawned us.
export const hermeticGitEnv = (): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
