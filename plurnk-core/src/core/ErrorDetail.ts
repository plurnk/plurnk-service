import { ErrorDetail } from "@plurnk/plurnk-meta";

export const ERROR_DETAIL_LIMIT = "PLURNK_SERVICE_ERROR_DETAIL_LIMIT";

// {§env-knob} — this package's bound.
export default new ErrorDetail(ERROR_DETAIL_LIMIT);
