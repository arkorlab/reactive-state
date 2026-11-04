/**
 * The methods of an array that call the function they are given first for its elements, whatever it
 * answers, by how many elements make them call it once: `filter`, `forEach` and their kin, of one;
 * `sort`, `toSorted`, of two, which they compare; reductions of two unless an initial value is given.
 */
export const CALLING: ReadonlyMap<string, number> = new Map([
  ['every', 1],
  ['filter', 1],
  ['find', 1],
  ['findIndex', 1],
  ['findLast', 1],
  ['findLastIndex', 1],
  ['flatMap', 1],
  ['forEach', 1],
  ['map', 1],
  ['reduce', 2],
  ['reduceRight', 2],
  ['some', 1],
  ['sort', 2],
  ['toSorted', 2],
]);
