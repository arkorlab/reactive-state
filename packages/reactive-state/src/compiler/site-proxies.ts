import {
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isObjectLiteralExpression,
  type Node,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { componentScope, moduleScope } from './component-values.ts';
import { moduleValue } from './exported-values.ts';
import { metadataInitializer } from './input-callees.ts';
import { proxyOrigin, type ProxyReading } from './proxy-origins.ts';
import type { SideState } from './reads.ts';
import type { Site } from './sites.ts';
import { skipsEvaluation } from './skipped-evaluation.ts';
import { attributeValues } from './slots.ts';

/** A source Proxy whose value reaches a dynamic site's measured calls or data containers. */
export function siteProxyOrigin(
  sites: readonly Site[],
  state: Pick<SideState, 'component' | 'modules'>,
): Node | undefined {
  const follow = (
    name: Parameters<NonNullable<ProxyReading['follow']>>[0],
  ): Expression | undefined => metadataInitializer(name) ?? moduleValue(state.modules, name);
  const reading: ProxyReading = {
    follow,
    functionOf: (callee) => {
      const scope =
        callee.getSourceFile() === state.component.sourceFile
          ? componentScope(state)
          : moduleScope(state.modules);
      return scope.functionOf(callee, { follow });
    },
  };
  const values: Expression[] = [];
  for (const site of sites) {
    const expressions = [
      ...attributeValues(site.element),
      ...site.conditions.map((each) => each.test),
    ];
    if (site.list !== undefined) {
      expressions.push(site.list.array, site.list.key);
      values.push(site.list.array);
    }
    for (const expression of expressions) {
      measuredExpressions(expression, values, follow);
    }
  }
  return proxyOrigin(values, reading);
}

/** Only source values the counting rewrite measures, without entering a named deferred body. */
function measuredExpressions(
  expression: Expression,
  values: Expression[],
  follow: NonNullable<ProxyReading['follow']>,
): void {
  const visit = (node: Node): void => {
    if (skipsEvaluation(node, follow)) {
      return;
    }
    if (
      isCallExpression(node) ||
      isObjectLiteralExpression(node) ||
      isArrayLiteralExpression(node)
    ) {
      values.push(node);
    }
    if (isArrowFunction(node) && !answersLater(node) && !isBlock(node.body)) {
      values.push(node.body);
    }
    node.forEachChild(visit);
  };
  visit(expression);
}
