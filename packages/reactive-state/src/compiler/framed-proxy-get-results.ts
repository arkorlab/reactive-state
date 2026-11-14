import {
  type Expression,
  isArrowFunction,
  isCallExpression,
  isComputedPropertyName,
  isElementAccessExpression,
  isFunctionDeclaration,
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
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
  type Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type PropertyName,
  type SpreadAssignment,
  SyntaxKind,
} from 'typescript/ast';

import { type Answering, answersLater, parametersOf, returnedBy } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { framedKeyNames } from './framed-keys.ts';
import { framedParameterWrites } from './framed-parameter-writes.ts';
import { framedNullishProxyStable, type ProxyNullishRead } from './framed-proxy-nullish-guards.ts';
import { framedNativeConstructor } from './framed-sources.ts';

/** A member read through a native Proxy answers what its directly written `get` trap returns. */

const PROXY: ReadonlySet<string> = new Set(['Proxy']);

/** One entry of a written handler, as an object literal holds it. */
type HandlerEntry = ObjectLiteralExpression['properties'][number];

/**
 * A written trap, or native forwarding through `Reflect.get` or an absent nullish trap, or a trap of
 * a handler too large to follow, which may answer a read with anything.
 */
type Trap = Answering | 'forward' | 'absent' | 'unknown';

/**
 * What a forwarding trap's own target or key parameter may hold where it returns: the original
 * unless a definite earlier write replaced it, what plain writes give it, or anything.
 */
interface Replacements {
  readonly original: boolean;
  readonly values: readonly Expression[];
  readonly any: boolean;
}

/** What a trap may answer a read with: the target's member it forwards, the target, or a value. */
type TrapResult =
  | { readonly kind: 'member'; readonly targets: Replacements; readonly keys: Replacements }
  | { readonly kind: 'target'; readonly targets: Replacements }
  | { readonly kind: 'value'; readonly value: Expression };

const ORIGINAL: Replacements = { any: false, original: true, values: [] };
const ANYTHING: Replacements = { any: true, original: true, values: [] };

/** The spreads one handler's walk visits: handlers that share handlers grow with their product. */
const SPREAD_VISITS = 1000;

/** A native Proxy's written target and the `get` traps its handler may hold. */
interface ProxyTraps {
  readonly proxy: Expression;
  readonly handler: Expression;
  readonly target: Expression;
  readonly traps: readonly Trap[];
}

/**
 * Whether a member read through a native Proxy may select an error by what its handler's written
 * synchronous `get` trap returns: the trap answers the read whatever its key, so each value it
 * returns, read in the trap's own lexical scope, stands where the read is and is followed along the
 * rest of the member path — `new Proxy({}, { get() { return caught; } }).x.stack`. A trap that
 * forwards the read, `Reflect.get(target, key)` or `target[key]` of its own parameters, or native
 * `Reflect.get` itself, answers the target's member of the read key. An explicitly nullish trap is
 * absent and forwards that read too.
 */
export function framedProxyGetMember(
  node: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
  point?: Node,
): boolean {
  let value = unwrapped(node);
  let path: readonly (string | undefined)[] = keys;
  for (;;) {
    const selected = path.length === 0 ? undefined : proxyGetTraps(value);
    if (selected !== undefined) return trapsAnswer(selected, path, error, point);
    if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
    path = [frameMemberName(value), ...path];
    value = unwrapped(value.expression);
  }
}

/**
 * Whether a written handler's `get` trap may forward a read to the target, as no trap does, with
 * the target and the key it was given: a trap whose writes may replace either answers otherwise.
 */
export function framedProxyGetForwards(
  handler: ObjectLiteralExpression,
  read?: ProxyNullishRead,
): boolean {
  const traps = handlerTraps(handler);
  const absent = read !== undefined && traps.includes('absent') && framedNullishProxyStable(read);
  return traps.some(
    (trap) =>
      (trap !== 'absent' || absent) && trapResults(trap).some((result) => unchanged(result)),
  );
}

/** A forwarded read that may use the target and the key the trap was given. */
function unchanged(result: TrapResult): boolean {
  return result.kind === 'member' && result.targets.original && result.keys.original;
}

/** Whether a trap's answer may be an error along the keys after the read key it answers. */
function trapsAnswer(
  selected: ProxyTraps,
  path: readonly (string | undefined)[],
  error: (value: Expression, path: readonly string[]) => boolean,
  point?: Node,
): boolean {
  const [read, ...rest] = path;
  const keys = rest.filter((key) => key !== undefined);
  if (keys.length !== rest.length) return false;
  const at = { keys, original: selected.target, read };
  const absent =
    selected.traps.includes('absent') && framedNullishProxyStable({ ...selected, point });
  return selected.traps.some(
    (trap) =>
      (trap !== 'absent' || absent) && trapResults(trap).some((r) => resultAnswers(r, at, error)),
  );
}

/**
 * Whether one trap result may be an error: a value along the keys; the target, or its member of
 * the read key, for the target and key the trap's own parameters may hold where it returns. A
 * target the compile cannot follow may be anything; a key it cannot read may select any member.
 */
function resultAnswers(
  result: TrapResult,
  at: {
    readonly original: Expression;
    readonly read: string | undefined;
    readonly keys: readonly string[];
  },
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  const { keys } = at;
  if (result.kind === 'value') return error(result.value, keys);
  if (result.targets.any) return true;
  const objects = [...(result.targets.original ? [at.original] : []), ...result.targets.values];
  if (result.kind === 'target') return objects.some((object) => error(object, keys));
  const names = readKeys(result.keys, at.read);
  return objects.some((object) => {
    return names === undefined
      ? anyMember(object, keys, error)
      : names.some((name) => error(object, [name, ...keys]));
  });
}

/** The keys a forwarded read may use; `undefined` where one is not read. */
function readKeys(keys: Replacements, read: string | undefined): readonly string[] | undefined {
  if (keys.any) return undefined;
  const names = read !== undefined && keys.original ? [read] : [];
  for (const value of keys.values) {
    const written = framedKeyNames(value);
    if (written === undefined) return undefined;
    names.push(...written);
  }
  return names;
}

/** Whether any written member of an object may be an error; one the compile cannot list may. */
function anyMember(
  object: Expression,
  keys: readonly string[],
  error: (value: Expression, path: readonly string[]) => boolean,
): boolean {
  const literal = constantSource(object);
  if (!isObjectLiteralExpression(literal)) return true;
  const names: string[] = [];
  for (const property of literal.properties) {
    const each = isSpreadAssignment(property) ? undefined : entryNames(property.name);
    if (each === undefined) return true;
    names.push(...each);
  }
  return names.some((name) => error(object, [name, ...keys]));
}

/**
 * What each return of a trap answers: a forwarded read of its own target and key parameters, with
 * what writes in the trap may have put in them (`framedParameterWrites`), or a value.
 */
function trapResults(trap: Trap): readonly TrapResult[] {
  if (trap === 'unknown') return [{ keys: ANYTHING, kind: 'member', targets: ANYTHING }];
  if (trap === 'forward' || trap === 'absent')
    return [{ keys: ORIGINAL, kind: 'member', targets: ORIGINAL }];
  const [target, key] = parametersOf(trap);
  return returnedBy(trap).map((value): TrapResult => {
    const returned = unwrapped(value);
    if (target !== undefined && namesParameter(returned, target))
      return { kind: 'target', targets: replacements(trap, target, returned) };
    return target !== undefined && key !== undefined && forwardedRead(returned, target, key)
      ? {
          keys: replacements(trap, key, returned),
          kind: 'member',
          targets: replacements(trap, target, returned),
        }
      : { kind: 'value', value };
  });
}

/** What a trap's parameter may hold where it returns, after the trap's own writes of it. */
function replacements(trap: Answering, parameter: ParameterDeclaration, point: Node): Replacements {
  const writes = framedParameterWrites(trap, parameter, point);
  if (writes.unknown) return { any: true, original: true, values: writes.values };
  return writes.definite === undefined
    ? { any: false, original: true, values: writes.values }
    : { any: false, original: false, values: [writes.definite] };
}

/** `Reflect.get(target, key, …)` or `target[key]` of the trap's own target and key parameters. */
function forwardedRead(
  value: Expression,
  target: Answering['parameters'][number],
  key: Answering['parameters'][number],
): boolean {
  if (isElementAccessExpression(value))
    return (
      namesParameter(unwrapped(value.expression), target) &&
      namesParameter(unwrapped(value.argumentExpression), key)
    );
  if (
    !isCallExpression(value) ||
    globalPathOf(unwrapped(value.expression))?.join('.') !== 'Reflect.get'
  )
    return false;
  const [object, name] = value.arguments;
  return (
    object !== undefined &&
    name !== undefined &&
    namesParameter(unwrapped(object), target) &&
    namesParameter(unwrapped(name), key)
  );
}

/** Whether an expression reads the trap's own parameter of that declaration. */
function namesParameter(value: Expression, parameter: Answering['parameters'][number]): boolean {
  return isIdentifier(value) && frameDeclarationOf(value) === parameter;
}

/** The target and `get` traps of a native Proxy made there or held by a whole constant alias. */
function proxyGetTraps(node: Expression): ProxyTraps | undefined {
  const parts = proxyParts(constantSource(node));
  const written = parts === undefined ? undefined : constantSource(parts.handler);
  if (parts === undefined || written === undefined || !isObjectLiteralExpression(written))
    return undefined;
  const traps = handlerTraps(written);
  return traps.length === 0
    ? undefined
    : { target: parts.target, handler: parts.handler, proxy: node, traps };
}

/** The target and handler a native `new Proxy(…)` or an immediate `Proxy.revocable(…).proxy` is given. */
function proxyParts(
  value: Expression,
): { readonly target: Expression; readonly handler: Expression } | undefined {
  if (isNewExpression(value)) {
    return framedNativeConstructor(value.expression, PROXY)
      ? writtenArguments(value.arguments ?? [])
      : undefined;
  }
  if (
    (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) ||
    frameMemberName(value) !== 'proxy'
  )
    return undefined;
  const call = unwrapped(value.expression);
  const method = isCallExpression(call) ? unwrapped(call.expression) : undefined;
  return method !== undefined &&
    isCallExpression(call) &&
    (isPropertyAccessExpression(method) || isElementAccessExpression(method)) &&
    frameMemberName(method) === 'revocable' &&
    framedNativeConstructor(method.expression, PROXY)
    ? writtenArguments(call.arguments)
    : undefined;
}

/** The first two arguments, where no spread moves them. */
function writtenArguments(
  args: readonly Expression[],
): { readonly target: Expression; readonly handler: Expression } | undefined {
  const [target, handler] = args;
  return target === undefined ||
    handler === undefined ||
    isSpreadElement(target) ||
    isSpreadElement(handler)
    ? undefined
    : { target, handler };
}

/** The literals a handler's walk is inside of, with the entries of each still to read. */
interface Walk {
  readonly active: Set<Node>;
  readonly open: { readonly entries: HandlerEntry[]; readonly literal: ObjectLiteralExpression }[];
  visits: number;
}

/**
 * The traps a written handler may hold under `get`, in source order: a definite later entry replaces
 * earlier ones; a name the compile cannot read, a spread it cannot follow and a setter, which may
 * pair with a getter of the name, keep them possible. A spread of a literal that is being expanded
 * already, by itself or through others (`const handler = { ...handler, get }`, which throws where
 * it runs: a constant read before its initializer), is one it cannot follow; the same literal
 * spread again once its first expansion is done is followed again, as it replaces what lies between.
 * Handlers that spread handlers that spread handlers, each twice (`{ ...h, ...h }`), cost the product
 * of their spreads: past `SPREAD_VISITS` the handler is read as holding a trap of anything.
 */
function handlerTraps(handler: ObjectLiteralExpression): readonly Trap[] {
  let traps: Trap[] = [];
  const walk: Walk = {
    active: new Set<Node>([handler]),
    open: [{ entries: handler.properties.toReversed(), literal: handler }],
    visits: 0,
  };
  for (let inside = walk.open.at(-1); inside !== undefined; inside = walk.open.at(-1)) {
    const entry = inside.entries.pop();
    if (entry === undefined) {
      walk.active.delete(inside.literal);
      walk.open.pop();
      continue;
    }
    if (isSpreadAssignment(entry)) {
      if (!enterSpread(entry, walk)) return ['unknown'];
      continue;
    }
    if (isSetAccessorDeclaration(entry)) continue;
    const names = entryNames(entry.name);
    if (names?.includes('get') === false) continue;
    const found = entryTraps(entry);
    if (names?.length === 1) traps = [...found];
    else traps.push(...found);
  }
  return traps;
}

/**
 * Takes a spread entry into the walk: the literal it holds, marked as being expanded, is read next,
 * unless it is one that is being expanded already. Whether the walk is within its visits.
 */
function enterSpread(entry: SpreadAssignment, walk: Walk): boolean {
  walk.visits += 1;
  if (walk.visits > SPREAD_VISITS) return false;
  const spread = constantSource(entry.expression);
  if (!isObjectLiteralExpression(spread) || walk.active.has(spread)) return true;
  walk.active.add(spread);
  walk.open.push({ entries: spread.properties.toReversed(), literal: spread });
  return true;
}

/** An entry's written names; none of a computed name the compile cannot read. */
function entryNames(name: PropertyName): readonly string[] | undefined {
  if (isComputedPropertyName(name)) return framedKeyNames(name.expression);
  if (isNumericLiteral(name)) return [String(Number(name.text))];
  return isIdentifier(name) || isStringLiteral(name) || isNoSubstitutionTemplateLiteral(name)
    ? [name.text]
    : undefined;
}

/** What an entry installs as its trap: a method, a function it holds, or one its getter returns. */
function entryTraps(entry: HandlerEntry): readonly Trap[] {
  if (isMethodDeclaration(entry)) return answersLater(entry) ? [] : [entry];
  if (isGetAccessorDeclaration(entry))
    return returnedBy(entry).flatMap((each) => writtenFunctions(each));
  if (isPropertyAssignment(entry)) return writtenFunctions(entry.initializer);
  return isShorthandPropertyAssignment(entry) && isIdentifier(entry.name)
    ? writtenFunctions(entry.name)
    : [];
}

/**
 * A synchronous function written there, held by a whole constant alias, or declared by its name;
 * native `Reflect.get`, or a source-known nullish value, which forwards as an absent trap.
 */
function writtenFunctions(node: Expression): readonly Trap[] {
  const value = constantSource(node);
  if (nullishTrap(value)) return ['absent'];
  if (globalPathOf(value)?.join('.') === 'Reflect.get') return ['forward'];
  if (isArrowFunction(value) || isFunctionExpression(value))
    return answersLater(value) ? [] : [value];
  const declared = isIdentifier(value) ? frameDeclarationOf(value) : undefined;
  return declared !== undefined && isFunctionDeclaration(declared) && !answersLater(declared)
    ? [declared]
    : [];
}

/** What a whole constant alias holds, through its own aliases; another value as it is. */
function constantSource(node: Expression): Expression {
  let value = unwrapped(node);
  const seen = new Set<Node>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = frameDeclarationOf(value);
    if (
      declared === undefined ||
      !isVariableDeclaration(declared) ||
      !isIdentifier(declared.name) ||
      declared.initializer === undefined ||
      !isVariableDeclarationList(declared.parent) ||
      !/^const\s/u.test(declared.parent.getText(declared.getSourceFile()))
    )
      return value;
    value = unwrapped(declared.initializer);
  }
  return value;
}

/** A nullish trap or a void of a source-known primitive installs no callable handler. */
function nullishTrap(value: Expression): boolean {
  if (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined')
    return true;
  if (!isVoidExpression(value)) return false;
  const operand = constantSource(value.expression);
  return (
    isNumericLiteral(operand) ||
    isStringLiteral(operand) ||
    isNoSubstitutionTemplateLiteral(operand) ||
    [SyntaxKind.FalseKeyword, SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword].includes(
      operand.kind,
    ) ||
    globalPathOf(operand)?.join('.') === 'undefined'
  );
}
