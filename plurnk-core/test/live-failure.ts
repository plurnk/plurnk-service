export const failAfterCleanup = async (
    primary: unknown,
    cleanup: () => Promise<void>,
): Promise<never> => {
    try {
        await cleanup();
    } catch (failure) {
        throw new AggregateError(
            [primary, failure],
            "live execution failed and cleanup also failed",
        );
    }
    throw primary;
};
