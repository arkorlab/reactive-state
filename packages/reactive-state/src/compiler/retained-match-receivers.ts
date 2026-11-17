import {
  type BinaryExpression,
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isForStatement,
  isIdentifier,
  isLiteralTypeNode,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isParenthesizedTypeNode,
  isPropertyAccessExpression,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTemplateExpression,
  isTemplateLiteralTypeNode,
  isTypeLiteralNode,
  isTypeOfExpression,
  isUnionTypeNode,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { literalKey } from './exported-values.ts';
import { frameBindingOf, frameDeclarationOf, frameMemberName } from './framed-bindings.ts';
import { readsOf } from './local-module-reads.ts';
import {
  ASSIGNING,
  handedTo,
  isConstList,
  type Target,
  unreplacedAt,
  writtenAt,
} from './local-write-paths.ts';
import { constantValue } from './numbers.ts';
import {
  constBindingOf,
  isMutationTarget,
  ownerScopeOf,
  resolveLocalConst,
  topWrapped,
} from './retained-match-paths.ts';
import { bindingIdentifiers, readsBinding } from './scope.ts';

/**
 * Positive primitive-string proofs (`isNullishOrString`) for `.match(...)` receivers and native
 * string pattern-method consumers in `retained-matches.ts`.
 */

const STRING_RETURNING_METHODS: ReadonlySet<string> = new Set([
  'charAt',
  'concat',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'slice',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
]);

const GLOBAL_STRING_CALLS: ReadonlySet<string> = new Set([
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'String',
  'String.fromCharCode',
  'String.fromCodePoint',
  'String.raw',
]);

/** Whether `node` contains an optional-chain `?.` step. */
function isOptionalChainExpr(node: Expression): boolean {
  let each = node;
  while (
    isPropertyAccessExpression(each) ||
    isElementAccessExpression(each) ||
    isCallExpression(each) ||
    isNonNullExpression(each)
  ) {
    if (!isNonNullExpression(each) && each.questionDotToken !== undefined) return true;
    each = each.expression;
  }
  return false;
}

/** Whether `type` is an explicit primitive `string` (or `string | null | undefined` if `allowNullish`). */
function isWrittenStringType(type: TypeNode, allowNullish: boolean): boolean {
  let current = type;
  while (isParenthesizedTypeNode(current)) current = current.type;
  if (current.kind === SyntaxKind.StringKeyword || isTemplateLiteralTypeNode(current)) return true;
  if (isLiteralTypeNode(current)) {
    return (
      isStringLiteral(current.literal) ||
      isNoSubstitutionTemplateLiteral(current.literal) ||
      (allowNullish && current.literal.kind === SyntaxKind.NullKeyword)
    );
  }
  if (
    allowNullish &&
    (current.kind === SyntaxKind.UndefinedKeyword || current.kind === SyntaxKind.NullKeyword)
  ) {
    return true;
  }
  return (
    isUnionTypeNode(current) &&
    current.types.length > 0 &&
    current.types.every((member) => isWrittenStringType(member, allowNullish))
  );
}

/** Resolves `keys` through nested `TypeLiteralNode` property signatures. */
function resolveTypeKeys(
  rootType: TypeNode,
  keys: readonly string[],
): { readonly optional: boolean; readonly type: TypeNode } | undefined {
  let current = rootType;
  let optional = false;
  for (const key of keys) {
    while (isParenthesizedTypeNode(current)) current = current.type;
    if (!isTypeLiteralNode(current)) return undefined;
    const matching = current.members.filter(isPropertySignatureDeclaration).filter((member) => {
      const memberName = isIdentifier(member.name) ? member.name.text : literalKey(member.name);
      return memberName === key;
    });
    const sole = matching.length === 1 ? matching[0] : undefined;
    if (sole?.type === undefined) return undefined;
    optional ||= sole.postfixToken?.kind === SyntaxKind.QuestionToken;
    current = sole.type;
  }
  return { optional, type: current };
}

/** Whether any bound identifier in `param` is reassigned or mutated in its owning function. */
function isParameterMutated(param: ParameterDeclaration, checkMembers: boolean): boolean {
  const owner = ownerScopeOf(param);
  const matchers = bindingIdentifiers(param.name).map((id) => readsOf(id, owner));
  const state = { mutated: false };
  const visit = (node: Node): void => {
    if (state.mutated) return;
    if (isIdentifier(node) && readsBinding(node) && matchers.some((match) => match(node))) {
      const top = topWrapped(node);
      const memberWrite =
        checkMembers &&
        (handedTo(top) !== undefined ||
          ((isPropertyAccessExpression(top.parent) || isElementAccessExpression(top.parent)) &&
            top.parent.expression === top &&
            isMutationTarget(topWrapped(top.parent))));
      if (memberWrite || isMutationTarget(top)) {
        state.mutated = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.mutated;
}

/** Checks binary expressions (`+`, `,`, `??`, `||`, `&&`) for primitive string proofs. */
function checkStringBinary(
  expr: BinaryExpression,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  const kind = expr.operatorToken.kind;
  if (kind === SyntaxKind.PlusToken) {
    return checkString(expr.left, false, visiting) || checkString(expr.right, false, visiting);
  }
  if (kind === SyntaxKind.CommaToken) return checkString(expr.right, allowNullish, visiting);
  if (kind === SyntaxKind.QuestionQuestionToken) {
    return (
      checkString(expr.left, true, visiting) && checkString(expr.right, allowNullish, visiting)
    );
  }
  if (kind === SyntaxKind.BarBarToken || kind === SyntaxKind.AmpersandAmpersandToken) {
    return (
      checkString(expr.left, allowNullish, visiting) &&
      checkString(expr.right, allowNullish, visiting)
    );
  }
  return false;
}

/** Checks call expressions (`String(...)` or `String.prototype` string-returning methods). */
function checkStringCall(
  call: CallExpression,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  if (!allowNullish && isOptionalChainExpr(call)) return false;
  const callee = unwrapped(call.expression);
  const path = globalPathOf(callee)?.join('.');
  if (path !== undefined && GLOBAL_STRING_CALLS.has(path)) return true;
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = frameMemberName(callee);
  if (method === undefined || !checkString(callee.expression, true, visiting)) return false;
  return STRING_RETURNING_METHODS.has(method) || (allowNullish && method === 'at');
}

/** Peels static member keys from `expr` down to its unwrapped root expression. */
function staticMemberPath(
  expr: PropertyAccessExpression | ElementAccessExpression,
): { readonly keys: readonly string[]; readonly root: Expression } | undefined {
  const keys: string[] = [];
  let current: Expression = expr;
  while (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
    const key = frameMemberName(current);
    if (key === undefined) return undefined;
    keys.unshift(key);
    current = unwrapped(current.expression);
  }
  return { keys, root: current };
}

/** Checks member access expressions (`holder.text`, `{ text: 'a' }.text`, `opts.text`). */
function checkStringMember(
  expr: PropertyAccessExpression | ElementAccessExpression,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  if (!allowNullish && isOptionalChainExpr(expr)) return false;
  const peeled = staticMemberPath(expr);
  if (peeled === undefined) return false;
  const { keys, root } = peeled;
  if (isObjectLiteralExpression(root) || isArrayLiteralExpression(root)) {
    const entry = writtenAt(root, keys, resolveLocalConst);
    return entry !== undefined && checkString(entry, allowNullish, visiting);
  }
  if (!isIdentifier(root)) return false;
  const bound = constBindingOf(root);
  if (bound !== undefined && !visiting.has(bound.id)) {
    const target: Target = {
      callsLocal: () => true,
      declared: bound.id,
      initializer: bound.initializer,
      keys,
      owner: ownerScopeOf(bound.id),
      resolve: resolveLocalConst,
    };
    const entry = unreplacedAt(target, keys);
    if (entry !== undefined) {
      return checkString(entry, allowNullish, new Set([...visiting, bound.id]));
    }
  }
  const selected = frameBindingOf(root);
  if (
    selected === undefined ||
    !isParameterDeclaration(selected.binding) ||
    selected.binding.type === undefined ||
    isParameterMutated(selected.binding, true)
  ) {
    return false;
  }
  const resolved = resolveTypeKeys(selected.binding.type, [...selected.keys, ...keys]);
  if (resolved === undefined || (!allowNullish && resolved.optional)) return false;
  return isWrittenStringType(resolved.type, allowNullish);
}

/** Checks a mutable (`let` / `var`) variable declaration whose initializer and writes are all strings. */
function checkMutableStringVar(
  decl: VariableDeclaration,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  if (!isIdentifier(decl.name)) return false;
  const container = decl.parent.parent;
  if (!isVariableStatement(container) && !isForStatement(container)) return false;
  const nextVisiting = new Set([...visiting, decl]);
  if (decl.initializer === undefined) {
    if (!allowNullish) return false;
  } else if (!checkString(decl.initializer, allowNullish, nextVisiting)) return false;
  const strictlyInitialized =
    decl.initializer !== undefined && checkString(decl.initializer, false, nextVisiting);
  const owner = ownerScopeOf(decl);
  const isRead = readsOf(decl.name, owner);
  const state = { valid: true };
  const visit = (node: Node): void => {
    if (!state.valid) return;
    if (isRead(node) && readsBinding(node)) {
      const top = topWrapped(node);
      if (isMutationTarget(top)) {
        const { parent } = top;
        const okWrite =
          isBinaryExpression(parent) &&
          parent.left === top &&
          ((ASSIGNING.has(parent.operatorToken.kind) &&
            checkString(parent.right, allowNullish, nextVisiting)) ||
            (parent.operatorToken.kind === SyntaxKind.PlusEqualsToken && strictlyInitialized));
        if (!okWrite) {
          state.valid = false;
          return;
        }
      }
    }
    node.forEachChild(visit);
  };
  owner.forEachChild(visit);
  return state.valid;
}

/** Checks a `ParameterDeclaration` reference `id` for an unmutated explicit `string` type. */
function checkStringParameter(
  id: Identifier,
  decl: ParameterDeclaration,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  if (decl.dotDotDotToken !== undefined || decl.type === undefined || visiting.has(decl)) {
    return false;
  }
  const selected = frameBindingOf(id);
  if (selected === undefined || isParameterMutated(decl, selected.keys.length > 0)) return false;
  const nextVisiting = new Set([...visiting, decl]);
  if (selected.keys.length === 0) {
    if (!allowNullish && decl.questionToken !== undefined) return false;
    if (
      decl.initializer !== undefined &&
      !checkString(decl.initializer, allowNullish, nextVisiting)
    ) {
      return false;
    }
    return isWrittenStringType(decl.type, allowNullish);
  }
  const memberType = resolveTypeKeys(decl.type, selected.keys);
  if (memberType === undefined || (!allowNullish && memberType.optional)) return false;
  return isWrittenStringType(memberType.type, allowNullish);
}

/** Checks identifier references (`const`, proven-string `let`/`var`, or typed `ParameterDeclaration`). */
function checkStringIdentifier(
  id: Identifier,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  const bound = constBindingOf(id);
  if (bound !== undefined) {
    return (
      !visiting.has(bound.id) &&
      checkString(bound.initializer, allowNullish, new Set([...visiting, bound.id]))
    );
  }
  const decl = frameDeclarationOf(id);
  if (decl === undefined || visiting.has(decl)) return false;
  if (isVariableDeclaration(decl) && isIdentifier(decl.name)) {
    return !isConstList(decl.parent) && checkMutableStringVar(decl, allowNullish, visiting);
  }
  return isParameterDeclaration(decl) && checkStringParameter(id, decl, allowNullish, visiting);
}

/** Positive proof that `expr` evaluates to a primitive `string` (or `null` / `undefined` if `allowNullish`). */
function checkString(
  expr: Expression,
  allowNullish: boolean,
  visiting: ReadonlySet<Node>,
): boolean {
  const value = unwrapped(expr);
  if (
    isStringLiteral(value) ||
    isNoSubstitutionTemplateLiteral(value) ||
    isTemplateExpression(value) ||
    isTypeOfExpression(value)
  ) {
    return true;
  }
  if (
    allowNullish &&
    (value.kind === SyntaxKind.NullKeyword || globalPathOf(value)?.join('.') === 'undefined')
  ) {
    return true;
  }
  if (typeof constantValue(value, resolveLocalConst) === 'string') return true;
  if (isConditionalExpression(value)) {
    return (
      checkString(value.whenTrue, allowNullish, visiting) &&
      checkString(value.whenFalse, allowNullish, visiting)
    );
  }
  if (isBinaryExpression(value)) return checkStringBinary(value, allowNullish, visiting);
  if (isCallExpression(value)) return checkStringCall(value, allowNullish, visiting);
  if (isPropertyAccessExpression(value) || isElementAccessExpression(value)) {
    return checkStringMember(value, allowNullish, visiting);
  }
  return isIdentifier(value) && checkStringIdentifier(value, allowNullish, visiting);
}

/** Positive proof that `expr` is a primitive `string` (or nullish, which throws/short-circuits on member calls). */
export function isNullishOrString(expr: Expression): boolean {
  return checkString(expr, true, new Set());
}
