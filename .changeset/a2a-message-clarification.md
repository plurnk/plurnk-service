---
"@plurnk/plurnk-a2a": major
---

The inbound exposure converses with its caller by message only. A Task no
longer enters `INPUT_REQUIRED`: the model asks the caller in its reply, and
the answer arrives as a later Task in the same Context. An interaction a Task
raises, such as a `question`, goes to the worker's owner like any other
worker's, and needs an interactive one.
