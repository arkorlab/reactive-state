import {
  type CallExpression,
  type Expression,
  type Identifier,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpression,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  isVariableStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedArgumentPrefix, framedMemberNames } from './framed-keys.ts';
import { framedNativeConstructor, framedSourceValues } from './framed-sources.ts';
import { framedAssignedValues } from './framed-writes.ts';
import { constantValue } from './numbers.ts';
import { intlBindingRead } from './render-intl-bindings.ts';
import { borrowedIntlRead } from './render-intl-borrowed.ts';
import { ADDITIONAL_INTL_FORMATTERS, fixedIntlLocale } from './render-intl-locales.ts';
import { literalIntlData, literalIntlOwnMethod } from './render-intl-methods.ts';
import { storedIntlReceiver } from './render-intl-projections.ts';
import { freshIntlReceiver } from './render-intl-receivers.ts';
import { intlReflectRead } from './render-intl-reflections.ts';

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
const DATE_FORMAT = 'Intl.DateTimeFormat';
const WRITABLE_FORMATTERS = new Set([
  'Intl.DurationFormat',
  'Intl.ListFormat',
  'Intl.PluralRules',
  'Intl.RelativeTimeFormat',
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
    (receiver === undefined ? undefined : implicitFormatter(receiver, names, node))
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
