export const failAfterCancellation = async (
    primary: unknown,
    cancel: () => Promise<void>,
): Promise<never> => {
    try {
        await cancel();
    } catch (cancellation) {
        throw new AggregateError(
            [primary, cancellation],
            "live loop failed and its cancellation also failed",
        );
    }
    throw primary;
};
