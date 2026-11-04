import type { Node } from 'typescript/ast';

import type { Resolve } from './numbers.ts';
import { numericArgumentThrows } from './throw-number-bigints.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** Native numeric argument conversions that necessarily consume a written primitive Symbol. */
export function numberSymbolArgumentThrows(node: Node, resolve: Resolve | undefined): boolean {
  return numericArgumentThrows(node, resolve, isSymbolWritten);
}
