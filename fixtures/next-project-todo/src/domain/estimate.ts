// A portable, deterministic helper shared by prediction and the server-owned updater.
export function addEstimate(current: number, step: number): number {
  return Math.min(1_000_000, Math.max(0, current + step));
}
