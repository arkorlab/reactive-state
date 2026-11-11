import {
  type ArrowFunction,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isOmittedExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { concatSource } from './framed-concat-properties.ts';
import { quietCopy, quietElementViews, type QuietCopyCall } from './framed-copy-guards.ts';
import { filterParameterDefaults } from './framed-filter-parameters.ts';
import { framedCondition } from './framed-sources.ts';

/**
 * Native filter numbers its result after skipping holes, and keeps an element for each truthy
 * predicate answer, which an async predicate's Promise always is: where the kept elements' places
 * are not shown, any of them may be selected.
 */

/**
 * A written constant predicate keeps or drops every element; other predicates keep each possible.
 * A kept element's result position is its source position only where the source is shown to have
 * no hole before it; elsewhere any kept element may be at the selected position.
 */
export function filteredArrayViews(
  copy: QuietCopyCall,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] {
  const base = { value: copy.receiver, index };
  const argument = copy.given[0];
  const predicate = argument === undefined ? undefined : unwrapped(argument);
  const written =
    predicate !== undefined && isArrowFunction(predicate) && !isBlock(predicate.body)
      ? framedCondition(predicate.body)
      : undefined;
  if (written === undefined || predicate === undefined || !isArrowFunction(predicate))
    return [{ ...base, index: undefined }];
  if (!written && !answersLater(predicate)) return [];
  return (
    compactedViews(copy, predicate, index, stable) ?? [
      written && holeFreeUpTo(copy.receiver, index, stable) ? base : { ...base, index: undefined },
    ]
  );
}

/**
 * A written literal, or a whole constant alias of one, with no omitted element up to the position:
 * a hole after it leaves it where it was.
 */
function holeFreeUpTo(
  receiver: Expression,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): boolean {
  const source = concatSource(receiver, stable);
  if (source === undefined || !isArrayLiteralExpression(source)) return false;
  const placed = index === undefined ? source.elements : source.elements.slice(0, index + 1);
  return placed.every((each) => !isOmittedExpression(each));
}

/**
 * A quiet immediately selected literal source keeps the present elements in their written order;
 * for other forms it answers nothing, and `filteredArrayViews` keeps a position only where no hole
 * comes before it.
 */
function compactedViews(
  copy: QuietCopyCall,
  predicate: ArrowFunction,
  index: number | undefined,
  stable: (receiver: Expression) => boolean,
): readonly ArrayElementView[] | undefined {
  const quiet = quietCopy(copy, copy.given.slice(1), stable);
  if (quiet === undefined) return undefined;
  const present = quiet.source.elements.filter((each) => !isOmittedExpression(each));
  const defaults = filterParameterDefaults(predicate, present, stable);
  if (defaults === undefined) return undefined;
  if (!answersLater(predicate) && present.length === quiet.source.elements.length) return undefined;
  return quietElementViews(
    copy,
    { ...quiet, roots: [...quiet.roots, ...defaults] },
    index === undefined ? present : present.slice(index, index + 1),
  );
}
