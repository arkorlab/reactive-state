import {
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isArrayLiteralExpression,
  isArrowFunction,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isTemplateExpression,
  type Node,
  type NonNullExpression,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { isMethodCallee, methodKey } from './method-calls.ts';
import { constantNumber } from './numbers.ts';
import { type Rewrite, spliced, splicedFrom, textOf, unusedName } from './splice.ts';

/**
 * What the program counts of what a dynamic site is computed of, against what a call of the site's
 * function may spend (`VIEW_LIMITS.steps`, `authority/steps.ts`): each value its code makes, with
 * its size, as it is made — what each call answers, the language's (`text.split('').join('--')`)
 * as a `shared` module's; what each `+` (`text + text`), template, array and object makes; what
 * each function a method is given answers; and what each `*` and `<<` is computed of, before it
 * computes — written through `$.counted(…)`. And each key it reads a member by that it computes,
 * written through `$.member(…)`. A method call captures its receiver and actual function through
 * `$.method(receiver, key)` before evaluating its arguments, preserving the receiver when called.
 */

/**
 * `rewrite`, with each value the code it rewrites makes written through `$.counted(…)` (`makes`), and
 * what each function within it answers; an optional chain a call is made within written to stop as
 * the language stops it (`guarded`).
 */
export function counting(sourceFile: SourceFile, rewrite: Rewrite): Rewrite {
  const counted: Rewrite = (node) => {
    if (isArrowFunction(node)) {
      return spliced(node, sourceFile, (child) => {
        if (child !== node.body) {
          return counted(child);
        }
        // What the body makes, written through `$.counted(…)` already (`makes`), is counted once.
        const text = textOf(child, sourceFile, counted);
        return makes(skipParentheses(child)) ? text : `$.counted(${text})`;
      });
    }
    const text = writtenOf(node, { counted, rewrite, sourceFile });
    if (isComputedKey(node)) {
      return `$.member(${text ?? spliced(node, sourceFile, counted)})`;
    }
    return isGrowingOperand(node)
      ? `$.counted(${text ?? spliced(node, sourceFile, counted)})`
      : text;
  };
  return counted;
}

/**
 * The operators that make a value larger than what they are of: `*`, and `<<` — of integers of
 * `bigint` a `shared` module's function may answer, as large as an operand says, at once.
 */
const GROWING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AsteriskToken,
  SyntaxKind.LessThanLessThanToken,
]);

/**
 * Whether `node` is what a growing operator (`GROWING`) is computed of, which the program counts
 * before it computes — so that an integer of `bigint` is refused before an operator makes it larger
 * (`authority/steps.ts`) — but a number the code writes, and what is counted as it is made already.
 */
function isGrowingOperand(node: Node): boolean {
  const { parent } = node;
  return (
    isBinaryExpression(parent) &&
    GROWING.has(parent.operatorToken.kind) &&
    parent.operatorToken !== node &&
    !makes(skipParentheses(node)) &&
    constantNumber(node as Expression) === undefined
  );
}

/**
 * `node` as `counting` writes it, but the key a member is read by: as `rewrite` writes it, a value
 * the code makes counted; the chain it ends, stopped as the language stops it (`guarded`); else
 * nothing, to keep it, what is within it written so.
 */
function writtenOf(
  node: Node,
  {
    counted,
    rewrite,
    sourceFile,
  }: { readonly counted: Rewrite; readonly rewrite: Rewrite; readonly sourceFile: SourceFile },
): string | undefined {
  const own = rewrite(node);
  if (own !== undefined) {
    return makes(node) ? `$.counted(${own})` : own;
  }
  const chain = isLink(node) && !continues(node) ? guarded(node, sourceFile, counted) : undefined;
  if (chain !== undefined) {
    return chain;
  }
  return makes(node) ? `$.counted(${spliced(node, sourceFile, counted)})` : undefined;
}

/**
 * Whether `node` is the key a member is read by that the code computes rather than writes —
 * `item[key]` — which the program writes through `$.member(…)`, so that what a view sends reaches
 * nothing that made a value (`constructor`, `authority/steps.ts`).
 */
function isComputedKey(node: Node): boolean {
  const { parent } = node;
  return (
    isElementAccessExpression(parent) &&
    parent.argumentExpression === node &&
    !isStringLiteral(node) &&
    !isNumericLiteral(node) &&
    !isNoSubstitutionTemplateLiteral(node)
  );
}

/** `node` within the parentheses around it. */
function skipParentheses(node: Node): Node {
  let each = node;
  while (isParenthesizedExpression(each)) {
    each = each.expression;
  }
  return each;
}

/** Whether `node` is a `+`. */
function isPlus(node: Node): node is BinaryExpression {
  return isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.PlusToken;
}

/**
 * Whether `node` makes a value of what it is given, which the program counts as it is made: a call,
 * a template of values, an array, an object, and a `+` — the last of a run of them, `a + b + c`,
 * whose operands the code writes, so that what the run makes is counted once.
 */
function makes(node: Node): boolean {
  if (isPlus(node)) {
    const { parent } = node;
    return !(isPlus(parent) && parent.left === node);
  }
  return (
    isCallExpression(node) ||
    isTemplateExpression(node) ||
    isArrayLiteralExpression(node) ||
    isObjectLiteralExpression(node)
  );
}

/** A link of a chain: what reads (`.b`, `[key]`), calls (`(…)`) or asserts (`!`) of the value before it. */
type Link = CallExpression | ElementAccessExpression | NonNullExpression | PropertyAccessExpression;

function isLink(node: Node): node is Link {
  return (
    isPropertyAccessExpression(node) ||
    isElementAccessExpression(node) ||
    isCallExpression(node) ||
    isNonNullExpression(node)
  );
}

/** Whether `link` reads, or calls, optionally: `?.`. */
function isOptional(link: Link): boolean {
  return !isNonNullExpression(link) && link.questionDotToken !== undefined;
}

/** Whether a link of the chain `node` is in reads or calls of it, so that `node` does not end it. */
function continues(node: Node): boolean {
  const { parent } = node;
  return isLink(parent) && parent.expression === node;
}

/** What a link is written as after what it reads or calls of, and how. */
interface Part {
  /** `.b`, `[key]`, `(…)` or `!`, what is within it rewritten; `.b` of `?.b` where `guard`. */
  readonly text: string;
  /** Whether the link is a call, whose answer the program counts. */
  readonly call: boolean;
  /** Whether the chain stops here by a test of its own, where what it read is `null` or `undefined`. */
  readonly guard: boolean;
  /** A called member's key, captured with its receiver before the call evaluates its arguments. */
  readonly method: string | undefined;
}

/**
 * The chain `top` ends, with each method captured through `$.method`. An optional receiver before
 * a captured method or counted call is evaluated once and tested before the rest of its chain,
 * including keys and arguments. Parentheses outside a chain still end that short-circuiting. A
 * chain without a method or a counted call after an optional receiver stays as written. The
 * grammar refuses optional calls (`?.(…)`, `checkCall`), so these tests concern receivers alone.
 */
function guarded(top: Link, sourceFile: SourceFile, counted: Rewrite): string | undefined {
  const links: Link[] = [];
  let head: Expression = top;
  while (isLink(head)) {
    links.unshift(head);
    head = head.expression;
  }
  // A `!` after the chain's last link asserts of its answer as a whole: it is written after it all.
  const asserted: Link[] = [];
  let last = links.at(-1);
  while (last !== undefined && isNonNullExpression(last)) {
    asserted.unshift(last);
    links.pop();
    last = links.at(-1);
  }
  const guards = guardsOf(links);
  if (guards.size === 0 && links.every((link) => !isMethodCallee(link))) {
    return undefined;
  }
  const context = { counted, sourceFile };
  const parts: Part[] = links.map((link, index) => {
    const guard = guards.has(index);
    const method = methodKey(link, sourceFile, counted);
    return {
      call: isCallExpression(link),
      guard,
      method,
      text: method === undefined ? partOf(link, guard, context) : '',
    };
  });
  // A name nothing within the tests reads, which would read it in its place.
  const read = new Set(
    parts.flatMap((part) => `${part.text} ${part.method ?? ''}`.match(/[\w$]+/gu) ?? []),
  );
  const name = unusedName('value', (each) => read.has(each));
  const after = (text: string, start: number): string => {
    let written = text;
    for (const [index, part] of parts.entries()) {
      if (index >= start && part.guard) {
        return `((${name}) => ${name} == null ? undefined : ${after(linked(name, part), index + 1)})(${written})`;
      }
      if (index >= start) {
        written = linked(written, part);
      }
    }
    return written;
  };
  const end = asserted.map((link) => partOf(link, false, context)).join('');
  return after(textOf(head, sourceFile, counted), 0) + end;
}

/** `text` with `part` written after it, a call's answer counted. */
function linked(text: string, part: Part): string {
  if (part.method !== undefined) {
    return `$.method(${text}, ${part.method})`;
  }
  return part.call ? `$.counted(${text}${part.text})` : `${text}${part.text}`;
}

/**
 * The links of `links` the chain stops at by a test of its own: each `?.` after which a call is made
 * before the next `?.`, but as the last link of the chain.
 */
function guardsOf(links: readonly Link[]): ReadonlySet<number> {
  const guards = new Set<number>();
  let optional: number | undefined;
  for (const [index, link] of links.entries()) {
    if (isOptional(link)) {
      optional = index;
    }
    if (
      optional !== undefined &&
      ((isCallExpression(link) && index < links.length - 1) || isMethodCallee(link))
    ) {
      guards.add(optional);
    }
  }
  return guards;
}

/**
 * The text of `link` after what it reads or calls of — `.b`, `[key]`, `(…)`, `!` — what is within
 * it rewritten; plain where `plain`, its `?.` written `.` (`?.[` as `[`), as a test stops the chain
 * before it.
 */
function partOf(
  link: Link,
  plain: boolean,
  { counted, sourceFile }: { readonly counted: Rewrite; readonly sourceFile: SourceFile },
): string {
  return splicedFrom(link, link.expression.end, sourceFile, (child) => {
    if (child === link.expression) {
      return '';
    }
    // A link holds one `?.`, its own.
    if (plain && child.kind === SyntaxKind.QuestionDotToken) {
      return isPropertyAccessExpression(link) ? '.' : '';
    }
    return counted(child);
  });
}
