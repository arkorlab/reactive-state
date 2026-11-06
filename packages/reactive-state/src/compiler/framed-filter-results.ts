import {
  type ArrowFunction,
  type Expression,
  isArrowFunction,
  isBlock,
  isOmittedExpression,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import type { ArrayElementView } from './framed-array-rest.ts';
import { quietAsyncFilterFallback } from './framed-async-filter-fallback.ts';
import { quietCopy, quietElementViews, type QuietCopyCall } from './framed-copy-guards.ts';
import { filterParameterDefaults } from './framed-filter-parameters.ts';
import { framedCondition } from './framed-sources.ts';

/**
 * Native filter numbers its result after skipping holes, and keeps an element for each truthy
 * predicate answer, which an async predicate's Promise always is: where the kept elements' places
 * are not shown, any of them may be selected.
 */

/** A written constant predicate keeps or drops every element; other predicates keep each possible. */
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
    compactedViews(copy, predicate, index, stable) ??
    (written || quietAsyncFilterFallback(copy, predicate, stable)
      ? [base]
      : [{ ...base, index: undefined }])
  );
}

/**
 * A quiet immediately selected literal source keeps the present elements in their written order;
 * other forms keep the original positions and the written body's truth.
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
