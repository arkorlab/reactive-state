import {
  type Expression,
  isGetAccessorDeclaration,
  isIdentifier,
  type TypeNode,
} from 'typescript/ast';

import type { TopLevel } from './analyze.ts';
import { answeringOf, overloadsOf } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { exportedMember, type MemberValue, memberPath } from './exported-values.ts';
import type { Modules } from './modules.ts';
import type { WrittenType } from './type-members.ts';
import { type TypeReading, typeReading } from './type-names.ts';

/** The declared return types of calls into the application's modules, without running them. */

/** A return annotation read in its function's file, with its own type parameters. */
export interface CallType extends WrittenType {
  readonly type: TypeNode;
  readonly reading: TypeReading;
}

interface Context {
  readonly names: ReadonlyMap<string, TopLevel>;
  readonly modules: Modules;
}

/** Every return annotation a function the code imports declares, through its constant aliases. */
export function callTypes(callee: Expression, context: Context): readonly CallType[] {
  const fn = answeringOf(importedValue(callee, context));
  if (fn === undefined || isGetAccessorDeclaration(fn)) {
    return [];
  }
  const declarations = overloadsOf(fn);
  const signatures = declarations.filter((each) => each.body === undefined);
  const callable = signatures.length === 0 ? declarations : signatures;
  return callable.flatMap((each): readonly CallType[] => {
    const { type, typeParameters } = each;
    if (type === undefined) {
      return [];
    }
    const sourceFile = each.getSourceFile();
    const at = { file: sourceFile.fileName, sourceFile };
    const parameters =
      typeParameters === undefined
        ? undefined
        : { declarations: typeParameters, file: at.file, given: true };
    return [{ at, optional: false, reading: typeReading(context.modules, parameters), type }];
  });
}

/** What a callee reads from an import, following constant names and static member selections. */
function importedValue(callee: Expression, { names, modules }: Context): MemberValue | undefined {
  const followed = new Set<Expression>();
  let value = unwrapped(callee);
  let selected: readonly string[] = [];
  while (!followed.has(value)) {
    followed.add(value);
    const { keys, root } = memberPath(value);
    selected = [...keys, ...selected];
    const entry = isIdentifier(root) ? names.get(root.text) : undefined;
    if (
      entry?.kind === 'constant' &&
      isIdentifier(entry.declaration.name) &&
      entry.declaration.initializer !== undefined
    ) {
      value = unwrapped(entry.declaration.initializer);
      continue;
    }
    if (entry?.kind !== 'import' || entry.binding.typeOnly) {
      return undefined;
    }
    const { binding } = entry;
    const file = binding.module.target.file;
    if (file === undefined) {
      return undefined;
    }
    if (binding.form !== 'namespace') {
      return exportedMember(modules, file, binding.exported, selected);
    }
    const [exported, ...rest] = selected;
    return exported === undefined ? undefined : exportedMember(modules, file, exported, rest);
  }
  return undefined;
}
