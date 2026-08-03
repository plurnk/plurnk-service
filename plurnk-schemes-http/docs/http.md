# http(s)://

Use a web URL as an addressable entry. An unscoped READ performs a guarded GET
or reuses a fresh stored GET representation, then streams the selected response
channel. HTML becomes a readable model-facing body (normally markdown); its
faithful DOM is retained separately. Auxiliary channels are never presented by
default.

| Operation                         | Remote action | Effect                                                                         |
| --------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| Unscoped `READ(http(s)://…)`      | GET           | Acquire/reuse the response and publish the selected channel                    |
| Scoped `READ(http(s)://…)<scope>` | None          | Read a range from the selected already-materialized channel; never refetch     |
| `FIND(http(s)://…):matcher`       | GET if needed | Prepare an exact URL, then return standard JSON metadata and match coordinates |
| `SEND[200](http(s)://…):body:`    | POST          | Submit the body and stream the response                                        |
| `EDIT(http(s)://…):body:`         | PUT           | Replace the whole remote resource; do not use a line scope                     |
| `KILL(http(s)://…)`               | DELETE        | Delete the remote resource and stream the response                             |

A path-pattern FIND searches only web entries already materialized in the
workspace; a pattern cannot discover the remote web. FIND returns navigation
metadata, not the selected page body. Use READ for content.

| Direct response           | `body`                                                       | Other channel                    |
| ------------------------- | ------------------------------------------------------------ | -------------------------------- |
| GET HTML                  | Readable projection of the guarded rendered page             | Faithful rendered DOM in `#html` |
| GET `text/event-stream`   | One event `data` value per chunk                             | Initial response in `#header`    |
| Other textual response    | Incremental UTF-8 text under its declared type               | Status and headers in `#header`  |
| Binary or undeclared type | Empty marker under its type or `application/octet-stream`    | Status and headers in `#header`  |

HTML projection presence is structural: a returned projection is accepted even
when its content is empty. `422 no-readable-projection` means HTML was acquired
but no model-facing body projection exists. A direct READ retains its faithful
`#html` and `#header` evidence; exact FIND preparation creates no entry.
An internal projection exception instead returns non-retryable
`500 projection-failed`; a browser failure returns retryable
`502 render-failed`.

A non-textual direct response returns `415 binary-response-unsupported`. The
remote response was received and its metadata remains in `#header`; do not
retry a POST, PUT, or DELETE solely to retrieve its binary body. Exact FIND
instead prunes non-textual responses because they cannot satisfy a text query.

`#header` contains the remote HTTP status line and headers. The PLURNK
operation result describes the streaming lifecycle; `SEND[code]` is never the
remote HTTP status. An HTTP 4xx/5xx response still streams normally and remains
visible in `#header`.

Re-reading without a scope uses the stored GET when it is inside the operator's
freshness window. Outside that window, stored ETag or Last-Modified validators
produce a conditional GET; a 304 restores the stored channels without
rendering. Without validators, the next READ performs a full GET. Responses to
POST, PUT, and DELETE are not reused as later GET representations.

A scoped READ never fetches. Its fragment, or `body` by default, selects an
already-materialized channel before the universal READ contract applies the
range. If that channel is absent, READ the URL without a scope to acquire the
response first.

Request headers ride inside the target as ordered trailing `{Key: value}`
blocks, one header per block:

```plurnk
<<READ(https://api.example.com/v1/me{Authorization: Bearer TOKEN}{Accept: application/json})::READ
<<EDIT(https://api.example.com/v1/thing/42{Authorization: Bearer TOKEN}{Content-Type: application/json}):{"done":true}:EDIT
```

Percent-encode `)`, `<`, and `}` inside a header value.

GET acquisition of a GitHub `…/blob/…` URL uses its
`raw.githubusercontent.com` source. The addressed GitHub URL remains entry
identity. POST, PUT, and DELETE never use that rewrite.

| Control                  | Effect                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `SEND[499](http(s)://…)` | Cancel the routed in-flight acquisition                               |
| `SEND[410](http(s)://…)` | Delete the local stored response; the next READ must acquire it again |

For a persistent bidirectional connection, use `wss://`.
