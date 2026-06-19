# e2e fixtures

- **`echo.gbnf`** — a tiny hand-written grammar (`root ::= "<<ECHO:" [a-z]* ":ECHO"`)
  used to pin the accept / incomplete / reject verdict trichotomy with certainty that
  does not depend on the oracle.

- **`plurnk.gbnf`** — a verbatim snapshot of `plurnk-grammar/dist/plurnk.gbnf`, the
  actual generated grammar that constrains the live model. It is the real-world
  situation this project exists to serve. Refresh it from the sibling repo when the
  grammar changes:

  ```sh
  cp ../plurnk-grammar/dist/plurnk.gbnf test/e2e/fixtures/plurnk.gbnf
  ```

  Corpus inputs in `test/e2e/_corpus.ts` reference real model output captured in
  `plurnk-service/test/digest/`.
