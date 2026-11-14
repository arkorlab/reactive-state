import type { TypeReading } from './local-type-environment.ts';
import { arrayElementReadings, memberReadings } from './local-type-selections.ts';

/** Nested native array elements retain their original argument environments and alias cycle guards. */
function nestedArrayReadings(
  readings: readonly TypeReading[],
  matches: (reading: TypeReading) => boolean,
  elements: (reading: TypeReading) => readonly TypeReading[],
): boolean {
  const pending = [...readings];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    if (matches(reading)) return true;
    pending.push(...elements(reading));
  }
  return false;
}

export interface ArrayReadingSelection {
  readonly index?: number | undefined;
  readonly nested?: boolean;
}

/** Written member paths retain their original environments before native array element selection. */
export function selectedArrayReadings(
  root: TypeReading,
  keys: readonly string[],
  selection: ArrayReadingSelection,
  proof: {
    readonly matches: (reading: TypeReading) => boolean;
    readonly operands: (reading: TypeReading) => readonly TypeReading[];
  },
): boolean {
  const arrays = memberReadings(root, keys, proof.operands);
  const readings = arrays.flatMap((array) =>
    arrayElementReadings(array, proof.operands, selection.index),
  );
  return selection.nested === true
    ? nestedArrayReadings(readings, proof.matches, (reading) =>
        arrayElementReadings(reading, proof.operands),
      )
    : readings.some((reading) => proof.matches(reading));
}
