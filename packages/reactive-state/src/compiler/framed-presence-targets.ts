import {
  type Expression,
  isIdentifier,
  isNewExpression,
  isNumericLiteral,
  isObjectLiteralExpression,
  isSpreadAssignment,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedArgumentPrefix } from './framed-keys.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Presence checks use the Proxy has trap rather than the independent member get trap. */
const PROXIES = new Set(['Proxy']);

/** Fresh nonintercepting Proxy handlers forward presence to their original target. */
export function framedPresenceTarget(node: Expression): Expression | undefined {
  const seen = new Set<Node>();
  let value = unwrapped(node);
  let selected = node;
  while (!seen.has(value)) {
    seen.add(value);
    const initial = constantInitializer(value);
    if (initial !== undefined) {
      value = unwrapped(initial);
      continue;
    }
    if (!isNewExpression(value) || !framedNativeConstructor(value.expression, PROXIES))
      return selected;
    const prefix = framedArgumentPrefix(value);
    const [target, handler] = prefix.values;
    if (
      target === undefined ||
      handler === undefined ||
      prefix.unknown ||
      prefix.alternatives !== undefined ||
      !transparentHandler(handler)
    )
      return undefined;
    selected = target;
    value = unwrapped(target);
  }
  return undefined;
}

/** Only a closed literal without a selected or inherited has trap proves forwarding. */
function transparentHandler(node: Expression): boolean {
  const value = unwrapped(node);
  return (
    isObjectLiteralExpression(value) &&
    value.properties.every((property) => {
      if (isSpreadAssignment(property)) return false;
      const name = property.name;
      if (!isIdentifier(name) && !isStringLiteral(name) && !isNumericLiteral(name)) return false;
      return name.text !== 'has' && name.text !== '__proto__';
    })
  );
}

/** Whole const aliases retain the original Proxy construction without conflating lexical shadows. */
function constantInitializer(node: Expression): Expression | undefined {
  if (!isIdentifier(node)) return undefined;
  const declared = frameDeclarationOf(node);
  return declared !== undefined &&
    isVariableDeclaration(declared) &&
    isIdentifier(declared.name) &&
    isVariableDeclarationList(declared.parent) &&
    /^const\b/u.test(declared.parent.getText(declared.getSourceFile()))
    ? declared.initializer
    : undefined;
}
