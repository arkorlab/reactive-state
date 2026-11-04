import {
  type Expression,
  type Identifier,
  isCallExpression,
  isConditionalExpression,
  isIdentifier,
  isNewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { INTROSPECTORS } from './alike.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { handedGlobal } from './handed-globals.ts';
import { parameterSources, type MetadataSource } from './input-bindings.ts';
import { metadataInitializer } from './input-callees.ts';
import { constructionSources } from './input-constructions.ts';
import { isKept, rootOf } from './kept.ts';
import { writtenBy } from './written.ts';

/** Shared reads of input metadata that differs between mutable browser JSON and frozen authority copies. */

const METADATA: ReadonlySet<string> = new Set([
  ...[...INTROSPECTORS].map((method) => `Object.${method}`),
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.isExtensible',
]);

/** Values made anew, or primitives, whose own flags do not come from a function's input. */
const FRESH: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.FunctionExpression,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

interface Target extends MetadataSource {
  readonly trail: ReadonlySet<Expression>;
}

/** The values that may supply a target's flags; none of a fresh value, unknown when not followed. */
function inputSources(source: MetadataSource): readonly MetadataSource[] | undefined {
  const { value } = source;
  if (isNewExpression(value)) {
    return constructionSources(value, source);
  }
  if (FRESH.has(value.kind)) {
    return [];
  }
  const root = rootOf(value);
  if (root !== undefined && isKept(root, writtenBy)) {
    return [];
  }
  if (isIdentifier(value)) {
    return identifierSources(value, source);
  }
  return isConditionalExpression(value)
    ? [value.whenTrue, value.whenFalse].map((each) => ({ ...source, value: each }))
    : undefined;
}

/** A parameter's actual argument or a local constant's own initializer. */
function identifierSources(
  value: Identifier,
  source: MetadataSource,
): readonly MetadataSource[] | undefined {
  const parameter = parameterSources(value, source);
  if (parameter !== undefined) {
    return parameter.sources;
  }
  const initializer = metadataInitializer(value);
  return initializer === undefined ? undefined : [{ ...source, value: initializer }];
}

/** Whether a target may retain a parameter's flags, following only proven fresh local aliases. */
function mayBeInput(node: Expression): boolean {
  const pending: Target[] = [{ bindings: new Map(), trail: new Set(), value: node }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const value = unwrapped(next.value);
    if (next.trail.has(value)) {
      return true;
    }
    const trail = new Set([...next.trail, value]);
    const sources = inputSources({ ...next, value });
    if (sources === undefined) {
      return true;
    }
    pending.push(...sources.map((source) => ({ ...source, trail })));
  }
  return false;
}

/** A metadata function held past its name, or called on what may be an input frozen on one side. */
export function inputMetadata(node: Node): string | undefined {
  if (isCallExpression(node)) {
    const path = globalPathOf(unwrapped(node.expression))?.join('.');
    const argument = node.arguments[0];
    if (
      argument !== undefined &&
      path !== undefined &&
      METADATA.has(path) &&
      mayBeInput(argument)
    ) {
      return `calls \`${path}()\` on what may be an input, whose flags differ between the browser's mutable value and the authority's frozen copy`;
    }
  }
  return handedGlobal(node, METADATA);
}
