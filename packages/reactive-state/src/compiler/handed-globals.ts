import {
  type BindingElement,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeOfExpression,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';

/**
 * What of a shared module's code reaches a member of a global's that answers otherwise as it runs,
 * or writes what it is given (`settled.ts`), past the name the compile reads it by: the global held
 * or handed on — `Reflect.get(Math, 'random')`, `Reflect.construct(Date, [])`, `const O = Object` —
 * or taken apart by the member's name, `const { random } = Math`; such a member handed on itself,
 * `const freeze = Object.freeze`; and the platform's classes that read the time as they make one,
 * held, handed on or extended, `class Stamped extends Event {}`.
 */

/** The platform's classes that read the time as they make one: a `File`'s `lastModified`, an event's `timeStamp`. */
const TIMED_CLASSES: ReadonlySet<string> = new Set(['Event', 'File']);

/** The globals a class of the application's may extend, as no member of them reads otherwise: `Error`. */
const EXTENDED_ALIKE: ReadonlySet<string> = new Set(['Error']);

/** The operators that compare what they are given, which hand on neither. */
const COMPARING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/**
 * What of `node` reaches past the names the compile reads what of a global answers otherwise as it
 * runs, or writes what it is given — of the members `reached` names, `Math.random`,
 * `Object.freeze` — or makes what reads the time (`TIMED_CLASSES`), said as a refusal says it; none
 * of another node, nor of a global read by the names of its members, called, tested or compared.
 */
export function handedGlobal(node: Node, reached: ReadonlySet<string>): string | undefined {
  const path = globalPathOf(node)?.join('.');
  if (path === undefined) {
    return undefined;
  }
  if (reached.has(path)) {
    return isCalledThere(node)
      ? undefined
      : `hands on \`${path}\`, which the compile reads where it is called alone`;
  }
  const members = [...reached]
    .filter((each) => each.startsWith(`${path}.`))
    .map((each) => each.slice(path.length + 1));
  if ((members.length === 0 && !TIMED_CLASSES.has(path)) || !handsOn(node, path, members)) {
    return undefined;
  }
  if (members.length === 0) {
    return `holds, hands on or extends \`${path}\`, which reads the time as it makes one, where the compile reads it made alone`;
  }
  const named = members.map((member) => `\`${path}.${member}\``).join(', ');
  return `holds or hands on \`${path}\`, of which ${named} the compile reads by their names alone`;
}

/** Whether `node` is called where it stands, `Object.freeze(box)`, or tested, or compared: what hands it on nowhere. */
function isCalledThere(node: Node): boolean {
  const { at, parent } = useOf(node);
  return (
    ((isCallExpression(parent) || isNewExpression(parent)) && parent.expression === at) ||
    isTypeOfExpression(parent) ||
    (isBinaryExpression(parent) && COMPARING.has(parent.operatorToken.kind))
  );
}

/**
 * Whether `node`, a global of `members` that answer otherwise as they run (or `root`, a class that
 * reads the time), is held or handed on where it stands — but read a member of by a name, called,
 * made, tested, compared, asked of a name (`in`) or of what it made (`instanceof`), extended where
 * it is `Error`, or taken apart by names none of `members`.
 */
function handsOn(node: Node, root: string, members: readonly string[]): boolean {
  const { at, parent } = useOf(node);
  if (
    (isPropertyAccessExpression(parent) || isCallExpression(parent) || isNewExpression(parent)) &&
    parent.expression === at
  ) {
    return false;
  }
  if (isElementAccessExpression(parent) && parent.expression === at) {
    return keyOf(unwrapped(parent.argumentExpression)) === undefined;
  }
  if (isTypeOfExpression(parent)) {
    return false;
  }
  if (isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    const asked = kind === SyntaxKind.InKeyword || kind === SyntaxKind.InstanceOfKeyword;
    return !(COMPARING.has(kind) || (asked && parent.right === at));
  }
  if (isExpressionWithTypeArguments(parent)) {
    return !EXTENDED_ALIKE.has(root);
  }
  // What a pattern stands beside is what it takes apart: `const { random } = Math`.
  if (isVariableDeclaration(parent) && isObjectBindingPattern(parent.name)) {
    return parent.name.elements.some((element) => {
      const key = takenKey(element);
      return key === undefined || members.includes(key);
    });
  }
  return true;
}

/** The name a pattern takes `element` apart by, where the code writes it; none of a rest, or a key it computes. */
function takenKey(element: BindingElement): string | undefined {
  if (element.dotDotDotToken !== undefined) {
    return undefined;
  }
  const key = element.propertyName ?? element.name;
  if (key === undefined) {
    return undefined;
  }
  return isIdentifier(key) ? key.text : keyOf(key);
}

/** The text `node` writes, a string; none of another node. */
function keyOf(node: Node): string | undefined {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}
