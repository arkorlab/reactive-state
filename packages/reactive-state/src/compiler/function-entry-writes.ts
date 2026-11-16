import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isMethodDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf, useOf } from './code-globals.ts';
import { frameDeclarationOf } from './framed-bindings.ts';
import { initializerOf } from './framed.ts';
import { declaredBindingTarget } from './function-binding-types.ts';
import {
  candidateObjects,
  literalElementKey,
  staticArgumentKey,
} from './function-candidate-objects.ts';
import {
  type AssignedCallable,
  callableWritesOnObject,
  type FileCallableIndex,
} from './function-spread-callables.ts';
import {
  EMPTY_WRITES,
  isDeclaredIdentifier,
  isSafeDirectUse,
  isSafeLockCall,
  isSkippedSyntax,
  type ObjectWrites,
  staticElementKey,
  unwrapTarget,
  VALUE_ASSIGNING,
} from './function-this-writes.ts';
import { targetsOf } from './kept.ts';
import { readsBinding } from './scope.ts';
import { writtenBy } from './written.ts';

/** Raw per-file assignment records collected in a single AST pass before resolving target objects. */
interface RawFileMutations {
  readonly assignCalls: { readonly sources: readonly Expression[]; readonly target: Expression }[];
  readonly memberWrites: {
    readonly callable: Node | Expression;
    readonly key: string | undefined;
    readonly receiver: Expression;
  }[];
  readonly variableWrites: Map<Node, Expression[]>;
}

/** Combined post-declaration write flags together with visible member and `Object.assign` values. */
export interface ObjectPostWrites {
  readonly assignSources: readonly Expression[];
  readonly memberValues: readonly AssignedCallable[];
  readonly writes: ObjectWrites;
}

const DIRECT_WRITES = new WeakMap<ObjectLiteralExpression, ObjectWrites>();
const FILE_INDEX = new WeakMap<SourceFile, FileCallableIndex>();
const POST_WRITES = new WeakMap<ObjectLiteralExpression, ObjectPostWrites>();
const WRITES = new WeakMap<ObjectLiteralExpression, ObjectWrites>();

/** Static key of an element access expression, including string, template and numeric literals. */
export function elementEntryKey(node: ElementAccessExpression): string | undefined {
  return staticElementKey(node);
}

/** Returns cached post-declaration writes, member assignments, and `Object.assign` sources for `object`. */
export function objectPostWrites(object: ObjectLiteralExpression): ObjectPostWrites {
  const cached = POST_WRITES.get(object);
  if (cached !== undefined) {
    return cached;
  }
  const index = fileCallableIndex(object.getSourceFile());
  const viaThis = callableWritesOnObject(object, index);
  const writes = mergeObjectWrites(directObjectWrites(object), viaThis);
  const directMembers = index.memberCallables.get(object) ?? [];
  const memberValues: AssignedCallable[] = [
    ...directMembers,
    ...viaThis.assignments.map((each) => ({ callable: each.value, key: each.key })),
  ];
  const assignSources = index.assignedSpreads.get(object) ?? [];
  const result: ObjectPostWrites = { assignSources, memberValues, writes };
  POST_WRITES.set(object, result);
  WRITES.set(object, writes);
  return result;
}

/** Computes and caches post-declaration and `this`-receiver writes affecting `object`. */
export function objectWrites(object: ObjectLiteralExpression): ObjectWrites {
  const cached = WRITES.get(object);
  if (cached !== undefined) {
    return cached;
  }
  const direct = directObjectWrites(object);
  if (direct.all) {
    WRITES.set(object, direct);
    return direct;
  }
  const index = fileCallableIndex(object.getSourceFile());
  const viaThis = callableWritesOnObject(object, index);
  const combined = mergeObjectWrites(direct, viaThis);
  WRITES.set(object, combined);
  return combined;
}

/** Combines direct reference writes and callable `this` writes into a single `ObjectWrites`. */
function mergeObjectWrites(left: ObjectWrites, right: ObjectWrites): ObjectWrites {
  if (left.all || right.all) {
    return { all: true, keys: EMPTY_WRITES.keys };
  }
  if (right.keys.size === 0) {
    return left;
  }
  if (left.keys.size === 0) {
    return right;
  }
  return { all: false, keys: new Set([...left.keys, ...right.keys]) };
}

/** Builds and caches the per-file assignment index for `file` in a single AST pass. */
function fileCallableIndex(file: SourceFile): FileCallableIndex {
  const cached = FILE_INDEX.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const raw: RawFileMutations = {
    assignCalls: [],
    memberWrites: [],
    variableWrites: new Map(),
  };
  const visit = (node: Node): void => {
    if (isSkippedSyntax(node)) {
      return;
    }
    collectRawMutation(node, raw);
    node.forEachChild(visit);
  };
  visit(file);
  const built = finalizeFileCallableIndex(raw);
  FILE_INDEX.set(file, built);
  return built;
}

/** Records variable/member assignments, `Object.assign`, and `Object.defineProperty` on `raw`. */
function collectRawMutation(node: Node, raw: RawFileMutations): void {
  if (isBinaryExpression(node) && VALUE_ASSIGNING.has(node.operatorToken.kind)) {
    const target = unwrapTarget(node.left);
    const rhs = unwrapped(node.right);
    if (isIdentifier(target)) {
      const declared = frameDeclarationOf(target);
      if (declared !== undefined && isVariableDeclaration(declared)) {
        const binding = declaredBindingTarget(target, declared);
        const list = raw.variableWrites.get(binding) ?? [];
        list.push(rhs);
        raw.variableWrites.set(binding, list);
      }
      return;
    }
    if (isPropertyAccessExpression(target) || isElementAccessExpression(target)) {
      const key = isPropertyAccessExpression(target) ? target.name.text : staticElementKey(target);
      raw.memberWrites.push({ callable: rhs, key, receiver: unwrapped(target.expression) });
    }
    return;
  }
  if (isCallExpression(node)) {
    collectCallMutation(node, raw);
  }
}

/** Records `Object.assign` spread sources and `Object.defineProperty` value descriptors. */
function collectCallMutation(call: CallExpression, raw: RawFileMutations): void {
  const path = globalPathOf(unwrapped(call.expression))?.join('.');
  const [first, keyArg, descArg] = call.arguments;
  if (first === undefined || isSpreadAssignment(first)) {
    return;
  }
  if (path === 'Object.assign' && call.arguments.length > 1) {
    const sources = call.arguments.slice(1).map((arg) => unwrapped(arg));
    raw.assignCalls.push({ sources, target: unwrapped(first) });
    return;
  }
  if (
    descArg !== undefined &&
    (path === 'Object.defineProperty' || path === 'Reflect.defineProperty')
  ) {
    const valueNode = descriptorValueNode(unwrapped(descArg));
    if (valueNode !== undefined) {
      const key = keyArg === undefined ? undefined : staticArgumentKey(unwrapped(keyArg));
      raw.memberWrites.push({ callable: valueNode, key, receiver: unwrapped(first) });
    }
  }
}

/** Extracts `value` from a property descriptor literal `{ value: fn }` or `{ value() {} }`. */
function descriptorValueNode(descriptor: Expression): Node | Expression | undefined {
  if (!isObjectLiteralExpression(descriptor)) {
    return undefined;
  }
  for (let index = descriptor.properties.length - 1; index >= 0; index -= 1) {
    const prop = descriptor.properties[index];
    if (prop !== undefined && literalElementKey(prop) === 'value') {
      if (isMethodDeclaration(prop)) {
        return prop;
      }
      if (isPropertyAssignment(prop)) {
        return unwrapped(prop.initializer);
      }
      if (isShorthandPropertyAssignment(prop) && isIdentifier(prop.name)) {
        return prop.name;
      }
    }
  }
  return undefined;
}

/** Resolves raw receiver expressions against `raw.variableWrites` into per-object maps. */
function finalizeFileCallableIndex(raw: RawFileMutations): FileCallableIndex {
  const memberMap = new Map<ObjectLiteralExpression, AssignedCallable[]>();
  for (const write of raw.memberWrites) {
    const receivers = candidateObjects(write.receiver, raw.variableWrites, new Set());
    for (const obj of receivers) {
      const list = memberMap.get(obj) ?? [];
      list.push({ callable: write.callable, key: write.key });
      memberMap.set(obj, list);
    }
  }
  const assignedSpreads = new Map<ObjectLiteralExpression, Expression[]>();
  for (const assign of raw.assignCalls) {
    const targets = candidateObjects(assign.target, raw.variableWrites, new Set());
    for (const obj of targets) {
      const list = assignedSpreads.get(obj) ?? [];
      list.push(...assign.sources);
      assignedSpreads.set(obj, list);
    }
  }
  return { assignedSpreads, memberCallables: memberMap, variableWrites: raw.variableWrites };
}

/** Computes and caches direct writes and escapes through lexical references to `object`. */
function directObjectWrites(object: ObjectLiteralExpression): ObjectWrites {
  const cached = DIRECT_WRITES.get(object);
  if (cached !== undefined) {
    return cached;
  }
  if (isInlineMemberReceiver(object)) {
    DIRECT_WRITES.set(object, EMPTY_WRITES);
    return EMPTY_WRITES;
  }
  const keys = new Set<string>();
  const state = { all: false };
  const visit = (node: Node): void => {
    if (state.all || isSkippedSyntax(node)) {
      return;
    }
    if (recordsDirectAllWrites(node, object, keys)) {
      state.all = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(object.getSourceFile());
  const result: ObjectWrites = { all: state.all, keys };
  DIRECT_WRITES.set(object, result);
  return result;
}

/** Whether `object` stands directly as the receiver of an inline member access (`({ pick() {} }).pick`). */
function isInlineMemberReceiver(object: ObjectLiteralExpression): boolean {
  const { at, parent } = useOf(object);
  return (
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === at
  );
}

/** Records direct writes to `object` from `node`, returning `true` when all keys become uncertain. */
function recordsDirectAllWrites(
  node: Node,
  object: ObjectLiteralExpression,
  keys: Set<string>,
): boolean {
  if (isCallExpression(node) && isSafeLockCall(node)) {
    return false;
  }
  const written = writtenBy(node);
  if (written !== undefined && writesUnknownDirectKey(written, object, keys)) {
    return true;
  }
  return isDirectLiteralReference(node, object) && !isSafeDirectUse(node);
}

/** Updates `keys` for direct assignment/mutation targets on `object`; answers `true` for whole/dynamic writes. */
function writesUnknownDirectKey(
  written: Node,
  object: ObjectLiteralExpression,
  keys: Set<string>,
): boolean {
  const targets = targetsOf(written);
  for (const rawTarget of targets) {
    const target = unwrapTarget(rawTarget);
    if (refersToLiteralNode(target, object)) {
      return true;
    }
    if (
      (isPropertyAccessExpression(target) || isElementAccessExpression(target)) &&
      refersToLiteral(target.expression, object)
    ) {
      const key = isPropertyAccessExpression(target) ? target.name.text : staticElementKey(target);
      if (key === undefined) {
        return true;
      }
      keys.add(key);
    }
  }
  return false;
}

/** Whether `node` evaluates directly to `object` via the literal itself or a lexical `const` alias. */
function isDirectLiteralReference(node: Node, object: ObjectLiteralExpression): boolean {
  if (node === object) {
    return true;
  }
  return (
    isIdentifier(node) &&
    !isDeclaredIdentifier(node) &&
    readsBinding(node) &&
    refersToLiteral(node, object)
  );
}

/** Narrowing wrapper around `refersToLiteral` for arbitrary write target syntax nodes. */
function refersToLiteralNode(node: Node, object: ObjectLiteralExpression): boolean {
  if (node === object) {
    return true;
  }
  return isIdentifier(node) && refersToLiteral(node, object);
}

/** Whether `node` resolves to `object` through lexical `const` initializers. */
function refersToLiteral(node: Expression, object: ObjectLiteralExpression): boolean {
  const seen = new Set<Expression>();
  let held = unwrapped(node);
  while (!seen.has(held)) {
    if (held === object) {
      return true;
    }
    seen.add(held);
    if (!isIdentifier(held)) {
      return false;
    }
    const initializer = initializerOf(held);
    if (initializer === undefined) {
      return false;
    }
    held = unwrapped(initializer);
  }
  return false;
}
