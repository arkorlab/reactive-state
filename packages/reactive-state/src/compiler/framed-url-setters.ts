import { URL as NativeURL } from 'node:url';

import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isStringLiteral,
  isPropertyAccessExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type NewExpression,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { argumentArrayExposed } from './framed-array-selections.ts';
import { arrayError } from './framed-arrays.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { framedNativeErrorInput } from './framed-native-error-inputs.ts';
import { framedQuietArrayWords, framedQuietSource } from './framed-native-evaluation.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** Native URL component setters convert supplied values to text before updating the URL. */
const URLS = new Set(['URL']);
const COMPONENTS = new Set([
  'hash',
  'host',
  'hostname',
  'href',
  'password',
  'pathname',
  'port',
  'protocol',
  'search',
  'username',
]);

interface ConvertedWords {
  readonly error: (value: Expression, keys?: readonly string[]) => boolean;
  readonly typed: (value: Expression) => boolean;
}

/** A fresh native URL and a quiet assignment keep the original inherited text setter. */
export function framedUrlSetterText(node: Node, words: ConvertedWords): boolean {
  if (!isBinaryExpression(node)) return false;
  const member = unwrapped(node.left);
  if (
    (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) ||
    !COMPONENTS.has(frameMemberName(member) ?? '') ||
    !quietValue(node.right)
  )
    return false;
  const source = nativeUrlSource(member.expression);
  const component = frameMemberName(member);
  if (
    source === undefined ||
    component === undefined ||
    argumentArrayExposed(member.expression, source.bindings) ||
    !assignmentRuns(node, source.construction, component)
  )
    return false;
  if (node.operatorToken.kind === SyntaxKind.EqualsToken)
    return words.error(node.right) || arrayError(node.right, words, node);
  return (
    (framedNativeErrorInput(node.right, node) && words.error(node.right)) ||
    (framedQuietArrayWords(node.right, words.error, node) && arrayError(node.right, words, node))
  );
}

/** A logical assignment executes only where an unchanged literal URL proves its selected string value. */
function assignmentRuns(
  node: BinaryExpression,
  construction: NewExpression,
  component: string,
): boolean {
  const operator = node.operatorToken.kind;
  if (operator === SyntaxKind.EqualsToken) return true;
  if (
    operator !== SyntaxKind.BarBarEqualsToken &&
    operator !== SyntaxKind.AmpersandAmpersandEqualsToken
  )
    return false;
  const member = unwrapped(node.left);
  if (isElementAccessExpression(member) && literalText(member.argumentExpression) === undefined)
    return false;
  const current = literalComponent(construction, component);
  return (
    current !== undefined &&
    (operator === SyntaxKind.BarBarEqualsToken ? current === '' : current !== '')
  );
}

/** Only literal input/base strings and unchanged whole const aliases seed a native URL value. */
function literalComponent(construction: NewExpression, component: string): string | undefined {
  const args = construction.arguments ?? [];
  const first = args[0];
  if (first === undefined || args.length > 2) return undefined;
  const second = args[1];
  const input = literalText(first);
  const base = second === undefined ? undefined : literalText(second);
  if (input === undefined || (second !== undefined && base === undefined)) return undefined;
  try {
    const value: unknown = Reflect.get(new NativeURL(input, base), component);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** String literals retain their exact spelling without executing a constant-value evaluator. */
function literalText(expression: Expression): string | undefined {
  const value = framedQuietSource(expression);
  return value !== undefined && (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value))
    ? value.text
    : undefined;
}

/** Whole immutable aliases preserve one directly constructed native URL identity. */
function nativeUrlSource(
  node: Expression,
):
  | { readonly bindings: ReadonlySet<FrameBinding>; readonly construction: NewExpression }
  | undefined {
  const aliases = new Set<FrameBinding>();
  let value = unwrapped(node);
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || aliases.has(selected.binding))
      return undefined;
    const { binding } = selected;
    if (
      !isVariableDeclaration(binding) ||
      !isIdentifier(binding.name) ||
      !isVariableDeclarationList(binding.parent) ||
      !/^const\b/u.test(binding.parent.getText(binding.getSourceFile())) ||
      binding.initializer === undefined
    )
      return undefined;
    aliases.add(binding);
    value = unwrapped(binding.initializer);
  }
  return isNewExpression(value) && framedNativeConstructor(value.expression, URLS)
    ? { bindings: aliases, construction: value }
    : undefined;
}

/** Binding reads and fresh primitive array entries perform no pre-set application work. */
function quietValue(node: Expression): boolean {
  const value = unwrapped(node);
  if (isIdentifier(value)) return true;
  return (
    isArrayLiteralExpression(value) &&
    value.elements.every((element) => {
      const entry = unwrapped(element);
      return (
        isIdentifier(entry) ||
        isNumericLiteral(entry) ||
        isStringLiteral(entry) ||
        isNoSubstitutionTemplateLiteral(entry) ||
        [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(
          entry.kind,
        )
      );
    })
  );
}
