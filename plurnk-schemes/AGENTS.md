# plurnk-schemes

`@plurnk/plurnk-schemes` defines the plugin contract for addressable resources.

The package owns scheme manifests, discovery, operation interfaces, and shared
result types. Individual scheme packages own protocol- or resource-specific
behavior.

Keep URI parsing standards-compliant and preserve one owner for each registered
scheme name. Shared wire shapes belong in `plurnk-contracts`; internal scheme
implementation types remain here. `SPEC.md` defines the plugin API.
