import {
  type BinaryExpression,
  type CallExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isNewExpression,
  isTaggedTemplateExpression,
  isTemplateExpression,
  type Node,
  SyntaxKind,
  type TemplateExpression,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { fixedDateText } from './dated.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedQuietTextPrefix } from './framed-text-prefix.ts';
import { LOCAL_TIME } from './local-date-inputs.ts';
import { localDateProjection } from './local-date-projections.ts';
import { constantValue } from './numbers.ts';

/** Native text conversions retain stored Date identities at the original rendered conversion. */

const DATES: ReadonlySet<string> = new Set(['Date']);
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);
const DATE_RANGE = { maximum: 8_640_000_000_000_000 } as const;

/** A source-known Date converted to text still reads its native local time zone. */
export function renderDateText(node: Node): string | undefined {
  if (!isCallExpression(node) && !isTemplateExpression(node) && !isBinaryExpression(node))
    return undefined;
  return convertsDate(node) && framedQuietTextPrefix(node, DATES) ? LOCAL_TIME : undefined;
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

/** Each untagged template substitution becomes text before any later expression is evaluated. */
function templateDate(node: TemplateExpression): boolean {
  if (isTaggedTemplateExpression(node.parent)) return false;
  for (const span of node.templateSpans) {
    if (projectedDate(span.expression)) return true;
    if (!framedQuietPrimitive(span.expression)) return false;
  }
  return false;
}

/** Quiet holder creation and unchanged local bindings cannot replace the selected conversion hook. */
function projectedDate(value: Expression): boolean {
  return localDateProjection(value, [], quietDateSource);
}

/** Added native consumers retain whole Date sources at the original conversion's exposure boundary. */
export function renderDateConversionSource(value: Expression, read: Expression): boolean {
  return localDateProjection(value, [], quietDateSource, { read, whole: true });
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
