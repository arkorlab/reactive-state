import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Written construct signatures retain their inferred instances and parameter compatibility. */
describe('constructor and optional source inference patterns', () => {
  it.each([
    {
      name: 'constructor result',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<new () => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'generic constructor alias',
      source:
        'type Factory<T> = new () => T; type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<Factory<Error>>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'abstract constructor result',
      source:
        'type Made<T> = T extends abstract new () => infer R ? R : never; function read(value: Made<abstract new () => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'concrete to abstract pattern',
      source:
        'type Made<T> = T extends abstract new () => infer R ? R : never; function read(value: Made<new () => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'constructor parameter inference',
      source:
        'type Argument<T> = T extends new (value: infer R) => unknown ? R : never; function read(value: Argument<new (value: Error) => unknown>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'finite constructor tuple rest',
      source:
        'type Made<T> = T extends new (...values: [string]) => infer R ? R : never; function read(value: Made<new (value: string) => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'constructor source union',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<(new () => Error) | (new () => { stack: string })>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'default generic result',
      source:
        'type Factory<T = Error> = new () => T; type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<Factory>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'optional function accepts explicit undefined',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<(value?: string) => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'optional constructor accepts explicit undefined',
      source:
        'type Made<T> = T extends new (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<new (value?: string) => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'ordinary constructor data',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<new () => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'abstract constructor data',
      source:
        'type Made<T> = T extends abstract new () => infer R ? R : never; function read(value: Made<abstract new () => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'abstract source cannot construct concrete',
      source:
        'type Made<T> = T extends new () => infer R ? R : { stack: string }; function read(value: Made<abstract new () => Error>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'concrete data matches abstract pattern',
      source:
        'type Made<T> = T extends abstract new () => infer R ? R : Error; function read(value: Made<new () => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'required constructor position',
      source:
        'type Made<T> = T extends new () => infer R ? R : { stack: string }; function read(value: Made<new (value: string) => Error>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'optional constructor position',
      source:
        'type Made<T> = T extends new () => infer R ? R : Error; function read(value: Made<new (value?: string) => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'incompatible constructor parameter',
      source:
        'type Made<T> = T extends new (value: number) => infer R ? R : { stack: string }; function read(value: Made<new (value: string) => Error>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'constructor is not a function',
      source:
        'type Made<T> = T extends () => infer R ? R : { stack: string }; function read(value: Made<new () => Error>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'function is not a constructor',
      source:
        'type Made<T> = T extends new () => infer R ? R : { stack: string }; function read(value: Made<() => Error>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'constructor data union',
      source:
        'type Made<T> = T extends new () => infer R ? R : never; function read(value: Made<(new () => { stack: string }) | (new () => { stack: string; id: string })>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'optional function data selects true branch',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : Error; function read(value: Made<(value?: string) => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'optional constructor data selects true branch',
      source:
        'type Made<T> = T extends new (value: string | undefined) => infer R ? R : Error; function read(value: Made<new (value?: string) => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'function optional tuple rest error',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<(...values: [value?: string]) => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'function optional tuple rest data',
      source:
        'type Made<T> = T extends (value: string | undefined) => infer R ? R : Error; function read(value: Made<(...values: [value?: string]) => { stack: string }>) { return value.stack; }',
      framed: false,
    },
    {
      name: 'constructor optional tuple rest error',
      source:
        'type Made<T> = T extends new (value: string | undefined) => infer R ? R : { stack: string }; function read(value: Made<new (...values: [value?: string]) => Error>) { return value.stack; }',
      framed: true,
    },
    {
      name: 'constructor optional tuple rest data',
      source:
        'type Made<T> = T extends new (value: string | undefined) => infer R ? R : Error; function read(value: Made<new (...values: [value?: string]) => { stack: string }>) { return value.stack; }',
      framed: false,
    },
  ])('$name', ({ source, framed }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'constructor-pattern.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node)?.includes('reads `stack` of an error') === true) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
