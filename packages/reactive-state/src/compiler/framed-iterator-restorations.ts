import {
  type BinaryExpression,
  type CallExpression,
  type DeleteExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isDeleteExpression,
  isElementAccessExpression,
  isExpressionStatement,
  isIdentifier,
  isNewExpression,
  isPropertyAccessExpression,
  isSourceFile,
  isSpreadElement,
  isStatement,
  type NewExpression,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { useOf } from './code-globals.ts';
import { frameBindingOf, frameMemberName, type FrameBinding } from './framed-bindings.ts';
import { iteratorPrefixQuiet } from './framed-iterator-guards.ts';
import { framedMapKey } from './framed-map-keys.ts';
import {
  framedQuietInputs,
  framedQuietPrimitive,
  framedQuietSource,
} from './framed-native-evaluation.ts';
import { framedPrefixSameOwner, framedQuietOwnerPrefix } from './framed-native-prefix.ts';
import { framedOriginCoowned } from './framed-origin-ownership.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { isTypeOnly } from './scope.ts';

/** One quiet unconditional deletion can restore a fresh native iterator's first next method. */

const COLLECTIONS = new Set(['Map', 'Set']);
const MAPS = new Set(['Map']);
const METHODS = new Set(['entries', 'keys', 'values']);
const REMOVE = new Set(['Reflect.deleteProperty']);
const OBSERVED = new Set(['columnNumber', 'fileName', 'lineNumber', 'message', 'name', 'stack']);
const IDENTITIES = new Set(COLLECTIONS);
for (const name of REMOVE) IDENTITIES.add(name);
for (const name of STANDARD_ERRORS) IDENTITIES.add(name);

interface FreshIterator {
  readonly acquisition: CallExpression;
  readonly construction: NewExpression;
  readonly method: string;
}

type Removal = CallExpression | DeleteExpression;

/** The added restoration proof leaves every unresolved override or evaluation at the existing boundary. */
export function framedIteratorRestored(
  source: Expression,
  bindings: ReadonlySet<FrameBinding>,
  next: CallExpression,
): boolean {
  const assignment = precedingAssignment(next);
  const fresh = freshIterator(source, next);
  if (
    assignment === undefined ||
    fresh === undefined ||
    !immediateObservation(next, fresh.method) ||
    !framedQuietInputs(next.arguments, STANDARD_ERRORS)
  )
    return false;
  const statement = containingStatement(next);
  const pending: Node[] = [statement];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node) || node.pos >= next.pos) continue;
    if (
      (isCallExpression(node) || isDeleteExpression(node)) &&
      node.end <= next.pos &&
      removesNext(node, bindings) &&
      commaPrefix(node, next) &&
      quietRestoration(node, { assignment, fresh, next })
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Only a quiet fresh named acquisition from a finite native Set or Map establishes the source. */
function freshIterator(source: Expression, next: CallExpression): FreshIterator | undefined {
  const value = unwrapped(source);
  if (!isCallExpression(value) || !framedPrefixSameOwner(value, next)) return undefined;
  const member = unwrapped(value.expression);
  if (!isPropertyAccessExpression(member) && !isElementAccessExpression(member)) return undefined;
  const method = frameMemberName(member);
  const construction = framedQuietSource(member.expression);
  if (
    method === undefined ||
    construction === undefined ||
    !METHODS.has(method) ||
    !isNewExpression(construction) ||
    !framedNativeConstructor(construction.expression, COLLECTIONS) ||
    !quietCollection(construction, next) ||
    !framedQuietInputs(value.arguments, STANDARD_ERRORS)
  )
    return undefined;
  return { acquisition: value, construction, method };
}

/** Native Map entry access and source construction cannot invoke an opaque iterator or entry getter. */
function quietCollection(construction: NewExpression, next: CallExpression): boolean {
  const first = construction.arguments?.[0];
  const input = first === undefined ? undefined : framedQuietSource(first);
  if (
    input === undefined ||
    !isArrayLiteralExpression(input) ||
    input.elements.some((each) => isSpreadElement(each)) ||
    !framedOriginCoowned(first ?? input, next) ||
    !framedQuietInputs(construction.arguments ?? [], STANDARD_ERRORS)
  )
    return false;
  return (
    !framedNativeConstructor(construction.expression, MAPS) ||
    input.elements.every((each) => {
      const entry = framedQuietSource(each);
      return (
        entry !== undefined &&
        isArrayLiteralExpression(entry) &&
        !entry.elements.some((value) => isSpreadElement(value))
      );
    })
  );
}

/** The already-proved own assignment is the immediately preceding expression statement. */
function precedingAssignment(next: CallExpression): BinaryExpression | undefined {
  const statement = containingStatement(next);
  if (!isStatement(statement)) return undefined;
  const parent = statement.parent;
  if (!isBlock(parent) && !isSourceFile(parent)) return undefined;
  const previous = parent.statements[parent.statements.indexOf(statement) - 1];
  if (previous === undefined || !isExpressionStatement(previous)) return undefined;
  const value = unwrapped(previous.expression);
  return isBinaryExpression(value) && value.operatorToken.kind === SyntaxKind.EqualsToken
    ? value
    : undefined;
}

/** Only the current ordinary statement contains a same-statement restoration. */
function containingStatement(next: CallExpression): Node {
  let node: Node = next;
  while (!isBlock(node.parent) && !isSourceFile(node.parent)) node = node.parent;
  return node;
}

/** A saved step or value does not acquire an origin through later member mutations. */
function immediateObservation(next: CallExpression, method: string): boolean {
  const step = followingMember(next);
  if (step === undefined || frameMemberName(step) !== 'value') return false;
  let value: Expression = step;
  if (method === 'entries') {
    const entry = followingMember(value);
    const slot = entry === undefined ? undefined : frameMemberName(entry);
    if (entry === undefined || (slot !== '0' && slot !== '1')) return false;
    value = entry;
  }
  const observed = followingMember(value);
  const name = observed === undefined ? undefined : frameMemberName(observed);
  return name !== undefined && OBSERVED.has(name);
}

/** Transparent wrappers keep only direct literal quiet member observations in evaluation order. */
function followingMember(value: Expression): Expression | undefined {
  const { at, parent } = useOf(value);
  if (
    (!isPropertyAccessExpression(parent) && !isElementAccessExpression(parent)) ||
    parent.expression !== at ||
    parent.questionDotToken !== undefined ||
    (isElementAccessExpression(parent) && !framedQuietPrimitive(parent.argumentExpression))
  )
    return undefined;
  return parent;
}

/** Only native Reflect deletion or direct deletion of this exact next slot can remove the override. */
function removesNext(removal: Removal, bindings: ReadonlySet<FrameBinding>): boolean {
  if (isDeleteExpression(removal)) {
    const member = unwrapped(removal.expression);
    return (
      (isPropertyAccessExpression(member) || isElementAccessExpression(member)) &&
      member.questionDotToken === undefined &&
      frameMemberName(member) === 'next' &&
      (!isElementAccessExpression(member) || framedQuietPrimitive(member.argumentExpression)) &&
      iteratorBinding(member.expression, bindings)
    );
  }
  const [target, key] = removal.arguments;
  return (
    framedNativeConstructor(removal.expression, REMOVE) &&
    target !== undefined &&
    key !== undefined &&
    iteratorBinding(target, bindings) &&
    framedMapKey(key) === 'text:next' &&
    framedQuietInputs(removal.arguments.slice(2), STANDARD_ERRORS)
  );
}

/** Whole iterator aliases retain lexical identity, never an inferred member result. */
function iteratorBinding(value: Expression, bindings: ReadonlySet<FrameBinding>): boolean {
  const name = unwrapped(value);
  if (!isIdentifier(name)) return false;
  const selected = frameBindingOf(name);
  return selected?.keys.length === 0 && bindings.has(selected.binding);
}

/** A comma prefix executes this deletion before the later lookup without a conditional branch. */
function commaPrefix(removal: Removal, next: CallExpression): boolean {
  let value: Expression = removal;
  for (;;) {
    const { at, parent } = useOf(value);
    if (!isBinaryExpression(parent) || parent.operatorToken.kind !== SyntaxKind.CommaToken)
      return false;
    if (parent.left === at && next.pos >= parent.right.pos && next.end <= parent.right.end)
      return true;
    value = parent;
  }
}

/** Earlier native source creation and the one own assignment add no unknown completed work. */
function quietRestoration(
  removal: Removal,
  proof: {
    readonly assignment: BinaryExpression;
    readonly fresh: FreshIterator;
    readonly next: CallExpression;
  },
): boolean {
  const { assignment, fresh, next } = proof;
  return (
    iteratorPrefixQuiet(removal, next) &&
    framedQuietOwnerPrefix(removal, {
      primitive: (value) => value === assignment || framedQuietPrimitive(value),
      value: (value) =>
        value === unwrapped(assignment.left) || framedNativeConstructor(value, IDENTITIES),
      call: (call) => call === fresh.acquisition,
      construct: (made) => made === fresh.construction || quietError(made),
    })
  );
}

/** A prior native Error of absent or guaranteed primitive written words cannot rewrite another source. */
function quietError(made: NewExpression): boolean {
  if (!framedNativeConstructor(made.expression, STANDARD_ERRORS)) return false;
  const args = made.arguments ?? [];
  return (
    args.length === 0 ||
    (args.length === 1 && args[0] !== undefined && framedQuietPrimitive(args[0]))
  );
}
