import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isComputedPropertyName,
  isConditionalExpression,
  isElementAccessExpression,
  isExpression,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSetAccessorDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isSpreadAssignment,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableStatement,
  type NewExpression,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type PropertyAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { sourceArrayMethod } from './framed-array-functions.ts';
import { executionOwner } from './framed-array-mutations.ts';
import {
  frameBindingOf,
  type FrameDeclaration,
  frameDeclarationOf,
  frameMemberName,
} from './framed-bindings.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { framedNativeConstructor, framedSourceValues } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { intlBindingRead } from './render-intl-bindings.ts';
import { borrowedIntlRead } from './render-intl-borrowed.ts';
import { ADDITIONAL_INTL_FORMATTERS, fixedIntlLocale } from './render-intl-locales.ts';
import { literalIntlData, literalIntlOwnMethod } from './render-intl-methods.ts';
import { storedIntlReceiver } from './render-intl-projections.ts';
import { freshIntlReceiver, wholeIntlConstant } from './render-intl-receivers.ts';
import { intlReflectRead } from './render-intl-reflections.ts';
import { isTypeOnly, readsBinding } from './scope.ts';

/** Native formatter receiver reads retain an implicit runtime locale or time zone. */

const FORMATTERS = new Map([
  ['Intl.Collator', new Set(['compare', 'resolvedOptions'])],
  [
    'Intl.DateTimeFormat',
    new Set(['format', 'formatRange', 'formatRangeToParts', 'formatToParts', 'resolvedOptions']),
  ],
  ['Intl.DisplayNames', new Set(['of', 'resolvedOptions'])],
  ['Intl.DurationFormat', new Set(['format', 'formatToParts', 'resolvedOptions'])],
  ['Intl.ListFormat', new Set(['format', 'formatToParts', 'resolvedOptions'])],
  [
    'Intl.NumberFormat',
    new Set(['format', 'formatRange', 'formatRangeToParts', 'formatToParts', 'resolvedOptions']),
  ],
  ['Intl.PluralRules', new Set(['resolvedOptions', 'select', 'selectRange'])],
  ['Intl.RelativeTimeFormat', new Set(['format', 'formatToParts', 'resolvedOptions'])],
  ['Intl.Segmenter', new Set(['resolvedOptions', 'segment'])],
]);
const ACCESSOR_SUFFIXES: ReadonlyMap<string, string> = new Map([
  ['Collator', 'compare'],
  ['DateTimeFormat', 'format'],
  ['NumberFormat', 'format'],
]);
const DATE_FORMAT = 'Intl.DateTimeFormat';
const WRITABLE_FORMATTERS = new Set([
  'Intl.DurationFormat',
  'Intl.ListFormat',
  'Intl.PluralRules',
  'Intl.RelativeTimeFormat',
]);
const NON_ACCESSOR_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'Array',
  'Date',
  'Error',
  'Headers',
  'Map',
  'RegExp',
  'Set',
  'URL',
  'URLSearchParams',
]);
const NON_ACCESSOR_PROTOTYPES: ReadonlySet<string> = new Set([
  'Array.prototype',
  'Boolean.prototype',
  'Date.prototype',
  'Function.prototype',
  'Number.prototype',
  'Object.prototype',
  'RegExp.prototype',
  'String.prototype',
]);

/** What a read selects of a possible formatter: it, the names read, and a receiver an accessor runs on. */
interface FormatterRead {
  readonly expression: Expression;
  readonly names: readonly string[] | undefined;
  readonly receiver?: Expression | undefined;
}

/** Only a native formatter's selected methods observe its stored default environment. */
export function renderIntlInput(node: Node): string | undefined {
  const borrowed = borrowedIntlRead(node, FORMATTERS);
  if (borrowed !== undefined)
    return implicitFormatter(borrowed.expression, borrowed.names, node, borrowed.kind);
  const read = formatterRead(node);
  if (read === undefined) return undefined;
  const { expression, names, receiver } = read;
  if (ownFormatterData(unwrapped(expression), names)) return undefined;
  return (
    implicitFormatter(expression, names, node) ??
    (receiver === undefined ? undefined : reflectedFormatter(expression, names, receiver, node))
  );
}

/** A member read, a pattern's entry, or a native `Reflect.get`, whose written receiver is read too. */
function formatterRead(node: Node): FormatterRead | undefined {
  if (isPropertyAccessExpression(node) || isElementAccessExpression(node))
    return { expression: node.expression, names: framedMemberNames(node) };
  return (
    intlBindingRead(node, (callee, names) => formatterKind(callee, names) !== undefined) ??
    intlReflectRead(node)
  );
}

/** A reflected receiver supplies `this` only when the target can resolve a native formatter getter. */
function reflectedFormatter(
  target: Expression,
  names: readonly string[] | undefined,
  receiver: Expression,
  node: Node,
): string | undefined {
  for (const [suffix, accessor] of ACCESSOR_SUFFIXES) {
    if (names !== undefined && !names.includes(accessor)) continue;
    const kind = `Intl.${suffix}`;
    if (!maySelectAccessor(target, kind, accessor, node)) continue;
    const found = implicitFormatter(receiver, [accessor], node, kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Only targets not proven to lack or shadow the native formatter getter can consume `receiver`. */
function maySelectAccessor(
  target: Expression,
  kind: string,
  accessor: string,
  read: Node,
): boolean {
  const pending: Expression[] = [target];
  const seen = new Set<Expression>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (seen.has(value)) continue;
    seen.add(value);
    const next = stepTargetCandidate(value, kind, accessor, read);
    if (next === undefined) return true;
    pending.push(...next);
  }
  return false;
}

/** Advances a target through custom-method proofs, branches, constants and literal prototypes. */
function stepTargetCandidate(
  value: Expression,
  kind: string,
  accessor: string,
  read: Node,
): readonly Expression[] | undefined {
  if (provenCustomTargetMethod(value, accessor, read)) return [];
  if (isConditionalExpression(value)) return [value.whenTrue, value.whenFalse];
  if (isIdentifier(value)) {
    const initializer = unexposedTargetInitializer(value, read);
    return initializer === undefined ? undefined : [initializer];
  }
  if (isObjectLiteralExpression(value)) return objectTargetNext(value, accessor);
  return nonObjectTargetMaySelect(value, kind) ? undefined : [];
}

/** A source-written target method shadows prototype accessors unless mutated inside the same call. */
function provenCustomTargetMethod(value: Expression, accessor: string, read: Node): boolean {
  if (value.pos < read.pos || !sourceArrayMethod(value, [accessor])) return false;
  let root = value;
  while (isPropertyAccessExpression(root) || isElementAccessExpression(root))
    root = unwrapped(root.expression);
  if (!isIdentifier(root)) return true;
  const binding = frameDeclarationOf(root);
  return binding !== undefined && !otherBindingUseInNode(read, binding, root);
}

/** Checks whether another argument in the same call references `binding` before `Reflect.get` runs. */
function otherBindingUseInNode(
  scope: Node,
  binding: FrameDeclaration,
  allowed: Identifier,
): boolean {
  const pending: Node[] = [scope];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      node !== allowed &&
      isIdentifier(node) &&
      readsBinding(node) &&
      frameDeclarationOf(node) === binding
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** An unmutated whole constant in the same block retains its original literal or native target. */
function unexposedTargetInitializer(name: Identifier, read: Node): Expression | undefined {
  const binding = wholeIntlConstant(name);
  if (binding?.initializer === undefined) return undefined;
  if (
    binding.parent.parent.parent !== readBlock(read) ||
    executionOwner(binding) !== executionOwner(read)
  )
    return undefined;
  const allowed = new Set<Node>([binding.name, name]);
  return unexposedBeforeEnd(read, binding, allowed) ? binding.initializer : undefined;
}

/** Rejects any other reference to `binding` before the reflective call finishes evaluating inputs. */
function unexposedBeforeEnd(
  read: Node,
  binding: FrameDeclaration,
  allowed: ReadonlySet<Node>,
): boolean {
  const owner = executionOwner(read);
  const pending: Node[] = [read.getSourceFile()];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    if (
      isIdentifier(node) &&
      !allowed.has(node) &&
      readsBinding(node) &&
      frameDeclarationOf(node) === binding &&
      (node.pos < read.end || executionOwner(node) !== owner)
    )
      return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** The nearest ordinary block or source file owning `read`. */
function readBlock(read: Node): Node {
  let node = read;
  while (!isBlock(node) && !isSourceFile(node)) node = node.parent;
  return node;
}

/** Object literals without a matching getter either shadow `accessor` or delegate to `__proto__`. */
function objectTargetNext(
  literal: ObjectLiteralExpression,
  accessor: string,
): readonly Expression[] | undefined {
  let shadowed = false;
  for (const entry of literal.properties.toReversed()) {
    if (matchingGetter(entry, accessor)) return undefined;
    if (ownDataPropertyNamed(entry, accessor)) return [];
    if (isSetAccessorDeclaration(entry) && optionName(entry.name) === accessor) shadowed = true;
  }
  if (shadowed) return [];
  const prototype = prototypeAssignment(literal);
  return prototype === undefined ? [] : [prototype];
}

/** Own or dynamically named getters run with `Reflect.get`'s supplied receiver. */
function matchingGetter(entry: ObjectLiteralElementLike, accessor: string): boolean {
  if (!isGetAccessorDeclaration(entry)) return false;
  const key = optionName(entry.name);
  return key === undefined || key === accessor;
}

/** Own data or method entries shadow prototype accessors without invoking a supplied receiver. */
function ownDataPropertyNamed(entry: ObjectLiteralElementLike, accessor: string): boolean {
  if (isShorthandPropertyAssignment(entry))
    return isIdentifier(entry.name) && entry.name.text === accessor;
  if (isMethodDeclaration(entry)) return optionName(entry.name) === accessor;
  if (!isPropertyAssignment(entry) || prototypeSetter(entry)) return false;
  return optionName(entry.name) === accessor;
}

/** Non-computed `__proto__: value` sets the object literal's prototype rather than an own field. */
function prototypeSetter(entry: PropertyAssignment): boolean {
  return !isComputedPropertyName(entry.name) && optionName(entry.name) === '__proto__';
}

/** The last prototype-setting entry on `literal`, if any. */
function prototypeAssignment(literal: ObjectLiteralExpression): Expression | undefined {
  for (const entry of literal.properties.toReversed()) {
    if (isPropertyAssignment(entry) && prototypeSetter(entry)) return entry.initializer;
  }
  return undefined;
}

/** Known primitives, functions, arrays and non-matching built-ins lack `kind`'s native accessor. */
function nonObjectTargetMaySelect(value: Expression, kind: string): boolean {
  if (primitiveOrPlainTarget(value)) return false;
  if (isNewExpression(value) || isCallExpression(value)) return callTargetMaySelect(value, kind);
  return prototypePathMaySelect(value, kind);
}

/** Fresh non-formatter literals cannot inherit an `Intl` prototype accessor. */
function primitiveOrPlainTarget(value: Expression): boolean {
  return (
    isArrayLiteralExpression(value) ||
    isArrowFunction(value) ||
    isFunctionExpression(value) ||
    isStringLiteral(value) ||
    isNumericLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    value.kind === SyntaxKind.TrueKeyword ||
    value.kind === SyntaxKind.FalseKeyword
  );
}

/** Formatter constructions match only their own kind; known non-formatter built-ins match none. */
function callTargetMaySelect(value: CallExpression | NewExpression, kind: string): boolean {
  const constructed = formatterKind(value.expression, undefined);
  if (constructed !== undefined) return constructed === kind;
  return !(
    isNewExpression(value) && framedNativeConstructor(value.expression, NON_ACCESSOR_CONSTRUCTORS)
  );
}

/** Known built-in `.prototype` expressions match only `kind`'s own prototype. */
function prototypePathMaySelect(value: Expression, kind: string): boolean {
  if (
    (isPropertyAccessExpression(value) || isElementAccessExpression(value)) &&
    frameMemberName(value) === 'prototype'
  ) {
    const ownerKind = formatterKind(value.expression, undefined);
    if (ownerKind !== undefined) return ownerKind === kind;
  }
  const path = globalPathOf(value)?.join('.');
  if (path === undefined) return true;
  if (NON_ACCESSOR_PROTOTYPES.has(path)) return false;
  for (const candidate of FORMATTERS.keys()) {
    if (path === `${candidate}.prototype`) return candidate === kind;
  }
  return true;
}

/** The first possible source of a receiver that is a native formatter of an environment default. */
function implicitFormatter(
  expression: Expression,
  names: readonly string[] | undefined,
  node: Node,
  requiredKind?: string,
): string | undefined {
  const pending: Expression[] = [expression];
  const stored = storedIntlReceiver(expression, node);
  if (stored !== undefined) pending.push(stored);
  const seen = new Set<Node>();
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    const value = unwrapped(at);
    if (seen.has(value)) continue;
    seen.add(value);
    if (isNewExpression(value) || isCallExpression(value)) {
      const kind = formatterKind(value.expression, names);
      if (
        kind !== undefined &&
        (requiredKind === undefined || kind === requiredKind) &&
        (!ADDITIONAL_INTL_FORMATTERS.has(kind) || freshIntlReceiver(expression, node) === value) &&
        implicitEnvironment(value, kind)
      )
        return `${kind}.locale`;
    }
    pending.push(...formatterSources(value));
  }
  return undefined;
}

/** Added native families keep the same closed own-method proof, including flat literal option results. */
function ownFormatterData(receiver: Expression, names: readonly string[] | undefined): boolean {
  return (
    literalIntlOwnMethod(receiver, names, (callee) =>
      framedNativeConstructor(callee, WRITABLE_FORMATTERS),
    ) ||
    literalIntlOwnMethod(
      receiver,
      names,
      (callee) => framedNativeConstructor(callee, ADDITIONAL_INTL_FORMATTERS),
      literalIntlData,
    )
  );
}

/** Possible whole receiver aliases and source-written replacement values retain their own construction. */
function formatterSources(value: Expression): readonly Expression[] {
  const results = [...(framedSourceValues(value) ?? [])];
  if (!isIdentifier(value)) return results;
  const selected = frameBindingOf(value);
  if (selected === undefined || selected.keys.length > 0) return results;
  const { initializer } = selected.binding;
  if (initializer !== undefined) results.push(initializer);
  results.push(...framedAssignedValues(value));
  return results;
}

/** Native constructors and whole immutable aliases keep only their own formatter method names. */
function formatterKind(
  callee: Expression,
  names: readonly string[] | undefined,
): string | undefined {
  for (const [kind, methods] of FORMATTERS) {
    if (names?.every((name) => !methods.has(name)) === true) continue;
    if (framedNativeConstructor(callee, new Set([kind]))) return kind;
  }
  return undefined;
}

/** A written locale and, for dates, a written zone remove the formatter's environment defaults. */
function implicitEnvironment(call: CallExpression | NewExpression, kind: string): boolean {
  const prefix = framedArgumentPrefix(call);
  if (prefix.alternatives !== undefined) return true;
  const [locale, options] = prefix.values;
  return (
    !fixedIntlLocale(locale, kind, localeText) || (kind === DATE_FORMAT && !fixedTimeZone(options))
  );
}

/** Written string requests retain the preexisting lexical constant-text proof. */
function localeText(node: Expression): string | undefined {
  const value = constantValue(unwrapped(node), constantInitializer);
  return typeof value === 'string' ? value : undefined;
}

/** Whole constant primitive aliases retain their text; mutable or projected aliases do not prove it. */
function fixedText(node: Expression): boolean {
  const value = localeText(node);
  return value !== undefined && value.length > 0;
}

/** A literal dictionary's last known timeZone entry survives only known later keys. */
function fixedTimeZone(node: Expression | undefined): boolean {
  if (node === undefined) return false;
  const value = unwrapped(node);
  if (!isObjectLiteralExpression(value)) return false;
  for (const entry of value.properties.toReversed()) {
    if (isSpreadAssignment(entry)) return false;
    const name = optionName(entry.name);
    if (name === undefined) return false;
    if (name === 'timeZone') return isPropertyAssignment(entry) && fixedText(entry.initializer);
  }
  return false;
}

/** Written option names remain literal; opaque computed names may replace the time zone. */
function optionName(node: Node): string | undefined {
  if (isIdentifier(node)) return node.text;
  const value = isComputedPropertyName(node) ? node.expression : node;
  const name = isExpression(value) ? constantValue(value, constantInitializer) : undefined;
  return name === undefined ? undefined : String(name);
}

/** A whole const declaration keeps a locale or zone primitive alias in its lexical scope. */
function constantInitializer(name: Identifier): Expression | undefined {
  const declaration = frameDeclarationOf(name);
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
    !isIdentifier(declaration.name)
  )
    return undefined;
  const statement = declaration.parent.parent;
  return isVariableStatement(statement) &&
    /^const\s/u.test(statement.declarationList.getText(statement.getSourceFile()))
    ? declaration.initializer
    : undefined;
}
