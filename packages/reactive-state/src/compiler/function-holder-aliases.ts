import {
  type Expression,
  isBinaryExpression,
  isConditionalExpression,
  type Identifier,
  isIdentifier,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { LOGICAL_FORWARDING } from './function-candidate-objects.ts';
import { isConstDeclaration, type ScanContext, withBranch } from './function-table-entries.ts';

/**
 * Whether `reaches` holds of the binding `holder` names, or of a binding `holder` is a `const`
 * alias of: `const alias = holder`, `const alias = flag ? holder : other`, `const alias = holder ??
 * other`, and an alias of such an alias. Each binding is asked once, so a ladder of aliases that
 * each name the one before twice stays as long as the ladder.
 */
export function reachesThroughAliases(
  holder: Expression,
  context: ScanContext,
  reaches: (binding: Expression, inner: ScanContext) => boolean,
): boolean {
  const asked = new Set<Node>();
  const pending: Expression[] = [holder];
  for (let binding = pending.pop(); binding !== undefined; binding = pending.pop()) {
    const alias = isIdentifier(binding) ? constantAlias(binding) : undefined;
    if (alias?.declared !== undefined) {
      if (asked.has(alias.declared)) {
        continue;
      }
      asked.add(alias.declared);
    }
    if (withBranch(context, (branch) => reaches(binding, branch))) {
      return true;
    }
    pending.push(...(alias?.sources ?? []));
  }
  return false;
}

/** The identifiers each `const` declaration's initializer is or chooses between, found once. */
const ALIAS_SOURCES = new WeakMap<Node, readonly Expression[]>();

/** The `const` declaration `binding` names and the identifiers its initializer is or chooses between. */
function constantAlias(
  binding: Identifier,
): { readonly declared: Node; readonly sources: readonly Expression[] } | undefined {
  const declared = frameDeclarationOf(binding);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isConstDeclaration(declared) ||
    !isIdentifier(declared.name)
  ) {
    return undefined;
  }
  let sources = ALIAS_SOURCES.get(declared);
  if (sources === undefined) {
    const { initializer } = declared;
    sources = initializer === undefined ? [] : aliasedHolders(unwrapped(initializer));
    ALIAS_SOURCES.set(declared, sources);
  }
  return { declared, sources };
}

/** The identifiers `expression` is, or chooses between: `holder`, `flag ? holder : other`, `holder ?? other`. */
function aliasedHolders(expression: Expression): readonly Expression[] {
  if (isIdentifier(expression)) {
    return [expression];
  }
  if (isConditionalExpression(expression)) {
    return [
      ...aliasedHolders(unwrapped(expression.whenTrue)),
      ...aliasedHolders(unwrapped(expression.whenFalse)),
    ];
  }
  return isBinaryExpression(expression) && LOGICAL_FORWARDING.has(expression.operatorToken.kind)
    ? [
        ...aliasedHolders(unwrapped(expression.left)),
        ...aliasedHolders(unwrapped(expression.right)),
      ]
    : [];
}
