import type { Node } from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { arrayFromLengthThrows } from './throw-array-from-lengths.ts';
import { arrayMutatorThrows } from './throw-array-mutators.ts';
import { typedMapResultThrows } from './throw-collection-callbacks.ts';
import { arrayDefinitionsThrow } from './throw-definitions.ts';
import { entryKeyThrows } from './throw-entry-keys.ts';
import { emptyTypedReductionThrows } from './throw-typed-reductions.ts';

/** Native collection operations whose written shapes establish a synchronous exception. */
export function nativeCollectionThrows(node: Node, resolve: Resolve | undefined): boolean {
  return (
    typedMapResultThrows(node, resolve) ||
    arrayDefinitionsThrow(node, resolve) ||
    arrayMutatorThrows(node, resolve) ||
    arrayFromLengthThrows(node, resolve) ||
    emptyTypedReductionThrows(node, resolve) ||
    entryKeyThrows(node, resolve)
  );
}
