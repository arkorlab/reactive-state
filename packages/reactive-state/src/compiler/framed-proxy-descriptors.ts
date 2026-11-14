import {
  type Expression,
  isArrowFunction,
  isBlock,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { answersLater } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { writtenArrayKey } from './framed-array-functions.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { framedDescriptorEntries } from './framed-descriptor-entries.ts';
import {
  framedProxyDescriptorFields,
  framedProxyDescriptorProjection,
} from './framed-proxy-descriptor-fields.ts';

/** A native Proxy descriptor read retains a directly written trap's data result. */
export function framedProxyDescriptorValues(
  node: Expression,
  names: readonly string[] | undefined,
  proof: {
    readonly consumer: Expression;
    readonly observation: Expression;
    readonly emptyBindingPrefix?: boolean;
    readonly keys?: readonly string[];
  },
): readonly Expression[] | undefined {
  const selected = proxyDescriptor(node);
  if (selected === undefined) return undefined;
  if (selected.trap === undefined) return framedDescriptorEntries(selected.target, names);
  const returned = descriptorResult(selected.trap);
  if (returned === undefined) return undefined;
  const added = framedProxyDescriptorFields(selected.creation, selected.trap, returned, {
    ...proof,
    names,
  });
  if (added !== undefined) return framedProxyDescriptorProjection(added, proof.keys ?? []);
  if (proof.emptyBindingPrefix === true || (proof.keys?.length ?? 0) > 0) return undefined;
  return framedDescriptorEntries(returned, ['value']);
}

/** A directly written descriptor trap replaces the target's descriptor observation. */
export function framedProxyDescriptorResult(node: Expression): Expression | undefined {
  const selected = proxyDescriptor(node);
  return selected?.trap === undefined ? undefined : descriptorResult(selected.trap);
}

/** A native Proxy target and its final directly written descriptor trap. */
function proxyDescriptor(node: Expression):
  | {
      readonly creation: NewExpression;
      readonly target: Expression;
      readonly trap: Node | undefined;
    }
  | undefined {
  const value = proxySource(node);
  if (!isNewExpression(value) || globalPathOf(unwrapped(value.expression))?.join('.') !== 'Proxy')
    return undefined;
  const [target, handler] = value.arguments ?? [];
  if (target === undefined || handler === undefined) return undefined;
  const written = unwrapped(handler);
  if (!isObjectLiteralExpression(written)) return undefined;
  let trap: Node | undefined;
  for (const property of written.properties) {
    if (isSpreadAssignment(property)) return undefined;
    const key = writtenArrayKey(property.name);
    if (key === undefined) return undefined;
    if (key === 'getOwnPropertyDescriptor') trap = property;
  }
  return { creation: value, target, trap };
}

/** A whole constant proxy alias keeps its construction without guessing destructured results. */
function proxySource(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      !isVariableDeclarationList(declared.parent) ||
      !/^const\s/u.test(declared.parent.getText(declared.getSourceFile())) ||
      declared.initializer === undefined
    )
      return value;
    value = unwrapped(declared.initializer);
  }
  return value;
}

/** Only synchronous direct method returns establish a trap's descriptor value. */
function descriptorResult(node: Node): Expression | undefined {
  const value = isPropertyAssignment(node) ? unwrapped(node.initializer) : node;
  if (!isMethodDeclaration(value) && !isFunctionExpression(value) && !isArrowFunction(value))
    return undefined;
  if (answersLater(value) || value.body === undefined) return undefined;
  if (!isBlock(value.body)) return value.body;
  for (const statement of value.body.statements) {
    if (isReturnStatement(statement)) return statement.expression;
    if (
      isVariableStatement(statement) &&
      /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    )
      continue;
    return undefined;
  }
  return undefined;
}
