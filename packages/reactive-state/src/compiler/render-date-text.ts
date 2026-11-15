import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isTaggedTemplateExpression,
  isTemplateExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { GLOBAL_OBJECTS, globalPathOf } from './code-globals.ts';
import { fixedDateText } from './dated.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { localDateProjection } from './local-date-projections.ts';
import { constantValue } from './numbers.ts';

/** Native text conversions retain stored Date identities at the original rendered conversion. */

const DATES: ReadonlySet<string> = new Set(['Date']);
const RAW_TAGS: ReadonlySet<string> = new Set(['String.raw']);
const RAW_DATE_FIELDS: ReadonlySet<string> = new Set(['Date', 'String', 'String.raw']);
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);
const DATE_RANGE = { maximum: 8_640_000_000_000_000 } as const;

/** A source-known Date converted to text still reads its native local time zone. */
export function renderDateText(node: Node): string | undefined {
  if (!isCallExpression(node) && !isTemplateExpression(node) && !isBinaryExpression(node))
    return undefined;
  if (!convertsDate(node)) return undefined;
  const rawFields = taggedRawFields(node);
  const natives = rawFields === undefined ? DATES : RAW_DATE_FIELDS;
  return framedQuietTextPrefix(node, natives, undefined, rawFields) ? LOCAL_TIME : undefined;
}

/** Only a selected native conversion needs the added earlier-execution proof. */
function convertsDate(node: BinaryExpression | CallExpression | TemplateExpression): boolean {
  if (isCallExpression(node)) return stringDate(node);
  if (isTemplateExpression(node)) return templateDate(node);
  if (!ADDING.has(node.operatorToken.kind)) return false;
  return (
    (projectedDate(node.left) && framedQuietPrimitive(node.right)) ||
    (framedQuietPrimitive(node.left) && projectedDate(node.right))
  );
}

/** Every written String argument is evaluated before the selected first input becomes text. */
function stringDate(node: CallExpression): boolean {
  if (
    globalPathOf(unwrapped(node.expression))?.join('.') !== 'String' ||
    node.arguments.slice(1).some((argument) => !framedQuietPrimitive(argument))
  )
    return false;
  const value = node.arguments[0];
  return value !== undefined && projectedDate(value);
}

/** Untagged templates convert spans in order; native String.raw evaluates all spans before coercing. */
function templateDate(node: TemplateExpression): boolean {
  const tagged = isTaggedTemplateExpression(node.parent);
  if (tagged && !quietRawTemplate(node)) return false;
  for (const span of node.templateSpans) {
    if (projectedDate(span.expression)) return true;
    if (!framedQuietPrimitive(span.expression)) return false;
  }
  return false;
}

/** A tagged template converts projected Dates only when native String.raw evaluates quiet spans. */
function quietRawTemplate(node: TemplateExpression): boolean {
  return (
    taggedRawFields(node) !== undefined &&
    node.templateSpans.every(
      (span) => projectedDate(span.expression) || framedQuietPrimitive(span.expression),
    )
  );
}

/** Prefix fields read by a coowned native String.raw tag on `node`, when `node` is its template. */
function taggedRawFields(node: Node): ReadonlySet<Expression> | undefined {
  return isTemplateExpression(node) &&
    isTaggedTemplateExpression(node.parent) &&
    node.parent.template === node &&
    framedOriginCoowned(node.parent.tag, node)
    ? nativeRawFields(node.parent.tag, node)
    : undefined;
}

/** Quiet holder creation and unchanged local bindings cannot replace the selected conversion hook. */
function projectedDate(value: Expression): boolean {
  return localDateProjection(value, [], quietDateSource);
}

/** Added native consumers retain whole Date sources at the original conversion's exposure boundary. */
export function renderDateConversionSource(value: Expression, read: Expression): boolean {
  return localDateProjection(value, [], quietDateSource, { read, whole: true });
}

/** Constant-key and whole-alias native String.raw targets, plus same-owner prefix fields they read. */
export function nativeRawFields(
  target: Expression,
  consumer: Expression,
): ReadonlySet<Expression> | undefined {
  const fields = new Set<Expression>();
  const tail: string[] = [];
  const seen = new Set<Node>();
  let value = unwrapped(target);
  while (!seen.has(value)) {
    seen.add(value);
    if (tail.length === 0 && framedNativeConstructor(value, RAW_TAGS)) return fields;
    const direct = globalPathOf(value);
    if (direct !== undefined) return isNativeRawPath([...direct, ...tail]) ? fields : undefined;
    const next = advanceRawTarget(value, consumer, tail, fields);
    if (next === undefined) return undefined;
    value = unwrapped(next);
  }
  return undefined;
}

/** Leading global-object holders collapse onto native String.raw just as globalPathOf collapses literals. */
function isNativeRawPath(parts: readonly string[]): boolean {
  let index = 0;
  while (parts.length - index > 1 && GLOBAL_OBJECTS.has(parts[index] ?? '')) index += 1;
  return parts.length - index === 2 && parts[index] === 'String' && parts[index + 1] === 'raw';
}

/** One constant member access or transparent target step while walking toward native String.raw. */
function advanceRawTarget(
  value: Expression,
  consumer: Expression,
  tail: string[],
  fields: Set<Expression>,
): Expression | undefined {
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    const name = frameMemberName(value);
    if (name === undefined) return undefined;
    if (framedPrefixSameOwner(value, consumer)) fields.add(value);
    tail.unshift(name);
    return value.expression;
  }
  return nextRawTarget(value);
}

/** Quiet comma prefixes and whole const initializers preserve a single native target identity. */
function nextRawTarget(value: Expression): Expression | undefined {
  if (isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.CommaToken)
    return framedQuietPrimitive(value.left) ? value.right : undefined;
  return isIdentifier(value) ? wholeConstInitializer(value) : undefined;
}

/** A whole const variable declaration's initializer, without following pattern projections. */
function wholeConstInitializer(name: Identifier): Expression | undefined {
  const selected = frameBindingOf(name);
  if (selected === undefined || selected.keys.length > 0) return undefined;
  const { binding } = selected;
  if (!isVariableDeclaration(binding) || !isVariableDeclarationList(binding.parent))
    return undefined;
  const statement = binding.parent.parent;
  return isVariableStatement(statement) &&
    /^const\b/u.test(binding.parent.getText(binding.getSourceFile()))
    ? binding.initializer
    : undefined;
}

/** An invalid Date has fixed text; only a known valid instant adds a local-time conversion input. */
function quietDateSource(source: Expression): boolean {
  if (!isNewExpression(source)) return framedQuietInputs([source], DATES);
  const [argument] = source.arguments ?? [];
  if (argument === undefined || source.arguments?.length !== 1) return false;
  const input = framedQuietSource(argument);
  if (input === undefined) return false;
  const constant = constantValue(input);
  let timestamp = NaN;
  if (typeof constant === 'number') timestamp = constant;
  else if (typeof constant === 'string' && fixedDateText(input)) timestamp = Date.parse(constant);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= DATE_RANGE.maximum;
}
