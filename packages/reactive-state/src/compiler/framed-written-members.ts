import { type Node, type SourceFile } from 'typescript/ast';

import { framedWrittenTargets } from './framed-written-targets.ts';

const WRITTEN = new WeakMap<SourceFile, ReadonlySet<Node>>();

/**
 * Whether a member access is written: assigned, a pattern's place for a value (an element, an
 * entry, a rest, a default), or the variable of a loop head.
 */
export function isWrittenMember(member: Node): boolean {
  const file = member.getSourceFile();
  const known = WRITTEN.get(file);
  if (known !== undefined) return known.has(member);
  const found = new Set<Node>();
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const target of framedWrittenTargets(node)) found.add(target);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  WRITTEN.set(file, found);
  return found.has(member);
}
