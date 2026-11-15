import {
  type Expression,
  type Identifier,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type PropertyName,
  SyntaxKind,
} from 'typescript/ast';

import type { Answering } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { metadataInitializer } from './input-callees.ts';
import { rootOf, targetsOf } from './kept.ts';
import type { Resolve } from './numbers.ts';
import { writtenBy } from './written.ts';

/** Source-written values that can carry a Proxy to a measured call result or container entry. */
export interface ProxyReading {
  readonly follow?: Resolve;
  readonly functionOf?: (callee: Expression) => Answering | undefined;
}

/** A lexical constant's initializer, or a source module's imported constant. */
export function heldConstant(name: Identifier, context: ProxyReading): Expression | undefined {
  return metadataInitializer(name) ?? context.follow?.(name);
}

/** Ordinary property names are literal, and computed names follow primitive constant keys. */
export function propertyKey(name: PropertyName, reading: ProxyReading): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  return isComputedPropertyName(name) ? originKey(name.expression, reading) : literalKey(name);
}

/** A key whose source is a literal, without application conversion or evaluation. */
export function originKey(value: Expression, reading: ProxyReading): string | undefined {
  return literalKey(sourceValue(value, reading));
}

/** A written boolean or nullish condition, without executing application code. */
export function literalTruth(value: Expression): boolean | undefined {
  if (value.kind === SyntaxKind.TrueKeyword) {
    return true;
  }
  return value.kind === SyntaxKind.FalseKeyword ||
    value.kind === SyntaxKind.NullKeyword ||
    globalOf(value) === 'undefined'
    ? false
    : undefined;
}

/** A lexical constant followed without executing application code or constructing compiler modules. */
export function sourceValue(node: Expression, reading: ProxyReading): Expression {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const held = heldConstant(value, reading);
    if (held === undefined) {
      break;
    }
    value = unwrapped(held);
  }
  return value;
}

/** A global callee reached through lexical aliases and source-written member keys. */
export function sourcePath(node: Expression, reading: ProxyReading): string | undefined {
  const keys: string[] = [];
  const seen = new Set<Expression>();
  let value = sourceValue(node, reading);
  while (!seen.has(value)) {
    seen.add(value);
    const path = globalPathOf(value);
    if (path !== undefined) {
      return [...path, ...keys].join('.');
    }
    if (isPropertyAccessExpression(value)) {
      keys.unshift(value.name.text);
    } else if (isElementAccessExpression(value)) {
      const key = originKey(value.argumentExpression, reading);
      if (key === undefined) {
        return undefined;
      }
      keys.unshift(key);
    } else {
      return undefined;
    }
    value = sourceValue(value.expression, reading);
  }
  return undefined;
}

/** A key represented by source text or a number alone. */
function literalKey(node: Node): string | undefined {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) || isNumericLiteral(node)
    ? node.text
    : undefined;
}

/** A prior explicit write prevents projecting a captured literal's original data entries. */
export function writtenBefore(name: Identifier, reading: ProxyReading): boolean {
  const declared = metadataInitializer(name)?.parent;
  if (declared === undefined) {
    return false;
  }
  const visit = (node: Node): boolean => {
    if (node.pos >= name.pos || node.end <= declared.end) {
      return false;
    }
    const target = writtenBy(node);
    if (
      target !== undefined &&
      targetsOf(target).some((each) => {
        const root = rootOf(each);
        return root !== undefined && sourceValue(root, reading) === sourceValue(name, reading);
      })
    ) {
      return true;
    }
    return node.forEachChild((child) => (visit(child) ? true : undefined)) === true;
  };
  return visit(name.getSourceFile());
}
