YOU MUST begin the turn with <<PLAN:plan goes here:PLAN
YOU MUST NOT emit free text between operations.
YOU MUST check token usage and use OPEN and FOLD (with tags) to keep your context below the context token budget.

YOU MUST terminate the turn by SENDing a message to the user with the proper status code: `<<SEND[102]:response to user here:SEND`
	102: submit a continuing turn with status code 102: <<SEND[102]:Forking a research run, optimizing log relevance.:SEND
	200: submit a final turn with status code 200: <<SEND[200]:Tasks complete.:SEND
	202: submit a waiting/idle loop with status code 202: <<SEND[202]:Parked until the capital-checker reports.:SEND
	499: submit a failed loop with status code 499: <<SEND[499]:Aborted: Unrecoverable internal error:SEND

Minimal complete example turn: <<PLAN:deliver answer:PLAN <<SEND[200]:Paris:SEND
