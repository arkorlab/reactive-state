import {
  isConditionalTypeNode,
  isIdentifier,
  isInferTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypeReferenceNode,
  type TypeReferenceNode,
} from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localTypeBinding } from '../src/compiler/local-type-aliases.ts';
import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { sequencePatternMatch } from '../src/compiler/local-type-sequence-patterns.ts';

/**
 * Reading a recursive alias re-enters it with new arguments, and the alias path ends the walk when
 * an environment comes back. Arguments built from inferred tuple positions (`[H, H, ...R]`) grow by
 * one position at each step without any syntax repeating, so no environment comes back: a type such
 * as `Pad`, which TypeScript ends by comparing a length, was read forever. An alias path past a
 * bound ends the way a repeated environment does; a recursion that finishes on its own does not
 * reach it.
 */

const STEPS = 60;

const GROWING =
  'type Grow<T extends unknown[]> = T extends [infer H, ...infer R] ? Grow<[H, H, ...R]> : T;\ntype Start = Grow<[Error, string]>;';
const SHRINKING =
  'type Drop<T extends unknown[]> = T extends [infer H, ...infer R] ? Drop<R> : never;\ntype Start = Drop<[Error, string, number, boolean]>;';
const REPEATING =
  'type Loop<T extends unknown[]> = T extends [infer H, ...infer R] ? Loop<[...T, H]> : never;\ntype Start = Loop<[Error, string]>;';

/** The reading of a type parameter's actual argument, through the references that name it. */
function resolved(at: TypeReading): TypeReading {
  let reading = at;
  while (isTypeReferenceNode(reading.type) && isIdentifier(reading.type.typeName)) {
    const binding = localTypeBinding(reading.type.typeName);
    const actual =
      binding !== undefined && binding !== null && isTypeParameterDeclaration(binding)
        ? reading.bindings.get(binding)
        : undefined;
    if (actual === undefined) break;
    reading = actual;
  }
  return reading;
}

describe('an alias path that grows without repeating', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Re-enters the alias the way the reader does for each match of its conditional, until it stops. */
  function walk(source: string): {
    readonly depth: number;
    readonly stopped: 'cut' | 'finished' | 'running';
  } {
    using parsed = api.createSourceFile('alias-paths.ts', source);
    const aliases = parsed.sourceFile.statements.filter(isTypeAliasDeclaration);
    const recursive = aliases.find((statement) => statement.name.text !== 'Start');
    const start = aliases.find((statement) => statement.name.text === 'Start');
    if (recursive === undefined || start === undefined) throw new Error('the aliases were missing');
    const body = recursive.type;
    if (!isConditionalTypeNode(body) || !isTypeReferenceNode(start.type)) {
      throw new Error('the recursion was not a conditional type');
    }
    let reference: TypeReferenceNode = start.type;
    let at = initialTypeReading(reference);
    for (let depth = 0; depth < STEPS; depth += 1) {
      const bound = boundTypeBody(recursive, reference, at);
      if (bound === undefined) return { depth, stopped: 'cut' };
      const checked = resolved({ ...bound, type: body.checkType });
      const match = sequencePatternMatch(checked, { ...bound, type: body.extendsType }, resolved);
      if (match?.matches !== true) return { depth, stopped: 'finished' };
      const bindings = new Map(bound.bindings);
      for (const { pattern, checked: actual } of match.pairs) {
        if (isInferTypeNode(pattern.type)) bindings.set(pattern.type.typeParameter, actual);
      }
      if (!isTypeReferenceNode(body.trueType))
        throw new Error('the next entry was not a reference');
      reference = body.trueType;
      at = { aliases: bound.aliases, bindings, type: reference };
    }
    return { depth: STEPS, stopped: 'running' };
  }

  it('ends where the arguments grow by an inferred position', () => {
    const { depth, stopped } = walk(GROWING);

    expect(stopped).toBe('cut');
    expect(depth).toBeGreaterThanOrEqual(16);
    expect(depth).toBeLessThan(STEPS);
  });

  it('does not end a recursion that finishes on its own (a pin)', () => {
    expect(walk(SHRINKING)).toStrictEqual({ depth: 4, stopped: 'finished' });
  });

  it('ends at once where the written arguments grow around themselves (a pin)', () => {
    const { depth, stopped } = walk(REPEATING);

    expect(stopped).toBe('cut');
    expect(depth).toBeLessThan(10);
  });
});
