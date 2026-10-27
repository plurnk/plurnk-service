import { ErrorDetail } from "@plurnk/plurnk-meta";

export const ERROR_DETAIL_LIMIT = "PLURNK_SCHEMES_HTTP_ERROR_DETAIL_LIMIT";

// {§env-knob} — this package's bound.
export default new ErrorDetail(ERROR_DETAIL_LIMIT);
