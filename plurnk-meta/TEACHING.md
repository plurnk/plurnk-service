# Teaching pages

The model-facing reference pages are one surface with one voice: every
`docs/*.md` a package ships for a scheme or family (materialized as
`worker:///_plurnk/plurnk/<name>.md` and surveyed at turn 0), the hot path in
`plurnk-contracts/plurnk.md`, and the `plurnk` skill's references. This note is
the rule for writing them. The owning `SPEC.md` is the authority for every
claim ({§teaching-corpus}); a page teaches the contract, it never restates it
as a second authority.

| Rule | Form |
| --- | --- |
| Mechanism, not advice | State what happens and what a shape does. No "prefer", "reach for", "when to use", no adjective that grades an option, no imperative aimed at the model. A guard is stated as the mechanism that makes the wrong move fail or names where the right thing goes. |
| One claim, one owner | Every sentence agrees with the owning contract tag; a claim that no tag backs is deleted, or the tag is written first. Behavior that a knob or a loop policy decides is stated as policy-dependent, never as absolute. |
| Numbers by name | A value that is a knob is cited by the knob's name, never by its shipped value. |
| Shapes, not purposes | An example shows the form. Its content implies no use the shape does not require: no reviewer, planner, scribe or builder, no fact lookup, no topology. |
| One home | A mechanism is taught on one page; another page points with one line. |
| Order by need | What a model acts on first comes first; rare features last. |
| Terse, not spare | A page covers what its scheme or family requires and nothing else. The survey row shows its size, and that size is paid on every READ and re-sent in every later packet. |
| One vocabulary | Terms, address forms and receipt shapes are spelled the same on every page and the same as the packet and the receipts. |
| Asides | The survey aside is one line: an example fence when the fence steers nothing, a sentence otherwise. |
| No contract tags on the page | Citations belong to specifications, code and coverage; a model-facing page carries none. Verification lives on the issue that landed the page. |

A file under `docs/` is materialized and taught; nothing meant for an operator
or a contributor lives there. Operator material belongs in the package README
beside its `.env.defaults`.
