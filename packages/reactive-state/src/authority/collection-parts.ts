import { types } from 'node:util';

/** Captured intrinsics read collection slots without consulting application overrides. */
const MAP_SIZE: unknown = Reflect.get(
  Object.getOwnPropertyDescriptor(Map.prototype, 'size') ?? {},
  'get',
);
const SET_SIZE: unknown = Reflect.get(
  Object.getOwnPropertyDescriptor(Set.prototype, 'size') ?? {},
  'get',
);
const MAP_FOR_EACH: unknown = Object.getOwnPropertyDescriptor(Map.prototype, 'forEach')?.value;
const SET_FOR_EACH: unknown = Object.getOwnPropertyDescriptor(Set.prototype, 'forEach')?.value;

/** The native cardinality is charged before bounded slot values are added to the traversal stack. */
export function readCollectionParts(
  value: unknown,
  spend: (cost: number) => void,
  queue: (held: unknown) => void,
): void {
  if (types.isMap(value)) {
    spend(Reflect.apply(MAP_SIZE as () => number, value, []));
    Reflect.apply(MAP_FOR_EACH as (...given: readonly unknown[]) => unknown, value, [
      (entry: unknown, key: unknown): void => {
        queue(key);
        queue(entry);
      },
    ]);
  } else if (types.isSet(value)) {
    spend(Reflect.apply(SET_SIZE as () => number, value, []));
    Reflect.apply(SET_FOR_EACH as (...given: readonly unknown[]) => unknown, value, [
      (entry: unknown): void => {
        queue(entry);
      },
    ]);
  }
}
