# e2e fixtures

- **`echo.gbnf`** — a tiny hand-written grammar (`root ::= "<|ECHO>" [a-z]* "<ECHO|>"`)
  used to pin the accept / incomplete / reject verdict trichotomy with certainty that
  does not depend on the oracle.

The PLURNK corpus in `test/e2e/_corpus.ts` serializes the owning
`plurnk-contracts` generator directly, so no generated grammar fixture is kept here.
