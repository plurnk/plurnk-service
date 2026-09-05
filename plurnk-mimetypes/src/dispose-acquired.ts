// {§mimetype-lifecycle}: acquisition errors belong to the requesting operation.
// The rejection handler applies only to acquisition, never to disposal.
export function disposeAcquired<T>(
    acquisition: Promise<T>,
    dispose: (resource: T) => void | Promise<void>,
): Promise<void> {
    return acquisition.then(dispose, () => undefined);
}
