import { ErrorDetail } from "@plurnk/plurnk-meta";

export const ERROR_DETAIL_LIMIT = "PLURNK_EXECS_ERROR_DETAIL_LIMIT";

// {§error-detail-bound} — this package's bound, shared by the executors built on it.
export default new ErrorDetail(ERROR_DETAIL_LIMIT);
