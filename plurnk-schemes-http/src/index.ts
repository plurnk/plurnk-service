// Public API barrel for @plurnk/plurnk-schemes-http.
// The default export is the scheme class plurnk-service registers at boot
// (plugin discovery scans node_modules/@plurnk/* for `plurnk.kind === "scheme"`).
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";
