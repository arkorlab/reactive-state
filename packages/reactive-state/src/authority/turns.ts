/** Waits for the next turn of the event loop: past what is queued now, as `setImmediate` does. */
export async function nextTurn(): Promise<void> {
  const scope = globalThis as Partial<Pick<typeof globalThis, 'setImmediate'>>;
  await new Promise<void>((resolve) => {
    if (scope.setImmediate === undefined) {
      setTimeout(resolve, 0);
    } else {
      scope.setImmediate(resolve);
    }
  });
}
