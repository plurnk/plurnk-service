# ruby

For continuing input, launch with `[{"stdin": "open"}]`, then SEND exact text to the
returned execution address; `[{"eof": true}]` closes stdin. See the
[live-input example](node.md#live-input), including newline framing.

The body is Ruby code, run with `ruby -e`. A script target runs that file and
receives the body as stdin; `[{"args": [...]}]` passes literal `ARGV` entries.

````ruby <!-- the body is the program -->
require "json"
words = %w[alpha beta alpha]
puts JSON.generate(words.tally)
````

````ruby (bin/migrate.rb) [{"args": ["--check"]}]
````

`puts` and `print` stream to `#stdout`, `warn` to `#stderr`; an unrescued
exception or `exit 1` closes with status 500 with the backtrace on stderr.
Gems resolve from the project's ordinary Ruby environment; `[{"cwd": "<directory>"}]`
selects the working directory when the project's `Gemfile` lives elsewhere.
