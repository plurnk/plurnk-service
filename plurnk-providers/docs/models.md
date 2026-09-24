# Models and generation

A route is `provider/model`; an alias names a route with its own tuning. The
worker owns its model and reasoning selection: an explicit selection persists
on the worker, a loop snapshots the resolved route, and a change to the
daemon's default does not retarget an existing worker. A child worker runs on
its parent's durable spawn selection, else the parent's own model.

Effort and budget are independent. The effort names available come from the
selected route, and an unsupported request is refused rather than downgraded.
Output accepts a token count or a percentage of context, capped by the model's
known limits; a reasoning budget, when set, is smaller than the total output,
and leaving it unset does not disable reasoning. Context is derived from the
endpoint or the catalog; an operator cap can only shrink it.

Cost is an estimate from known usage and catalog rates unless the provider
reports a settled charge. A timeout is a failure, never a fabricated response;
an interrupted call is reissued within the loop's recovery window, after which
the loop parks for a prompt or a wake.
