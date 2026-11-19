import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Whole rest captures preserve shape, actual argument environments and cycle identities. */
const CASES = [
  {
    name: 'finite suffix retains its error prefix',
    source:
      'type Front<T> = T extends [...infer R, unknown] ? R : never; type Failure = Front<[Error, string]>[0];',
    error: true,
  },
  {
    name: 'finite suffix excludes the final error',
    source:
      'type Front<T> = T extends [...infer R, unknown] ? R : never; type Failure = Front<[{ stack: string }, Error]>[0];',
    error: false,
  },
  {
    name: 'empty inferred tuple selects its known branch',
    source:
      'type Empty<T> = T extends [unknown, ...infer R] ? R extends [] ? Error : { stack: string } : { stack: string }; type Failure = Empty<[string]>;',
    error: true,
  },
  {
    name: 'empty inferred tuple excludes unreachable error',
    source:
      'type Empty<T> = T extends [unknown, ...infer R] ? R extends [] ? { stack: string } : Error : { stack: string }; type Failure = Empty<[Error]>;',
    error: false,
  },
  {
    name: 'readonly target retains the selected rest error',
    source:
      'type Tail<T> = T extends readonly [unknown, ...infer R] ? R : never; type Failure = Tail<readonly [string, Error]>[0];',
    error: true,
  },
  {
    name: 'readonly source does not satisfy mutable target',
    source:
      'type Tail<T> = T extends [unknown, ...infer R] ? R : [{ stack: string }]; type Failure = Tail<readonly [string, Error]>[0];',
    error: false,
  },
  {
    name: 'native readonly array rest infers a mutable error array',
    source:
      'type Tail<T> = T extends [unknown, ...infer R] ? R extends Error[] ? Error : { stack: string } : { stack: string }; type Failure = Tail<[string, ...ReadonlyArray<Error>]>;',
    error: true,
  },
  {
    name: 'native readonly array rest infers a mutable data array',
    source:
      'type Tail<T> = T extends [unknown, ...infer R] ? R extends { stack: string }[] ? { stack: string } : Error : { stack: string }; type Failure = Tail<[string, ...ReadonlyArray<{ stack: string }>]>;',
    error: false,
  },
  {
    name: 'first repeated generic retains its own actual error',
    source:
      'type One<T> = [T]; type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, ...One<Error>, ...One<{ stack: string }>]>[0];',
    error: true,
  },
  {
    name: 'second repeated generic retains its distinct data',
    source:
      'type One<T> = [T]; type Tail<T> = T extends [unknown, ...infer R] ? R : never; type Failure = Tail<[string, ...One<Error>, ...One<{ stack: string }>]>[1];',
    error: false,
  },
  {
    name: 'unchanged inferred sequence recursion terminates',
    source:
      'type Again<T> = T extends [...infer R] ? Again<R> : never; type Failure = Again<[{ stack: string }]>;',
    error: false,
  },
  {
    name: 'finite decreasing inferred sequence reaches its error',
    source:
      'type Strip<T> = T extends [unknown, ...infer R] ? Strip<R> : Error; type Failure = Strip<[string, { stack: string }]>;',
    error: true,
  },
] as const;

describe('whole tuple rest capture boundaries', () => {
  it.each(CASES)('$name', (row) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'whole-rest-captures.ts',
      `${row.source} function read(error: Failure) { return error.stack; }`,
    );
    let framed = false;
    const pending: Node[] = [parsed.sourceFile];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) framed = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(framed).toBe(row.error);
  });
});
