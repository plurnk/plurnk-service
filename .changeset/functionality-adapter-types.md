---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-modules": minor
---

`FunctionalityAdapter` gains `Definition` and `Snapshot` type parameters, and
`FunctionalityPreparation`, `FunctionalityPrepared`, `FunctionalityAdmission`,
`FunctionalityServiceDefinition`, `FunctionalityPreparedDefinition` and
`FunctionalityDefinitionSource` carry them; each defaults to the previous type.
`registerFunctionalityAdapter` infers both from the adapter it registers.
