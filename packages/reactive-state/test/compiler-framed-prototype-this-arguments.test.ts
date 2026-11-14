import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object` given as the `this` of a call of `call`, `apply` or `bind` is let go, whatever the function: a
 * function the code writes may read any member of it, `this[key]`, and so may reach `setPrototypeOf`, and
 * a function the code stores on `Object` or `Reflect` (`Object.reader = function …`) is a member the
 * language does not name, which is no more one of the uses that reach no prototype than the function it
 * holds. A function of the language's own, called with a holder as its `this`, is let go too: the list
 * of uses has none that gives a holder to a call.
 */
const CASES = [
  {
    id: 'user-function-called-with-object-as-this',
    source: `function frames(a: unknown[], name: string, key: string) { function reader(this: any, k: string) { return this[k]; } const change = reader.call(Object, key); (change as any)(a, {}); }`,
    changes: true,
  },
  {
    id: 'user-function-applied-with-object-as-this',
    source: `function frames(a: unknown[], name: string, key: string) { function reader(this: any, k: string) { return this[k]; } const change = reader.apply(Object, [key]); (change as any)(a, {}); }`,
    changes: true,
  },
  {
    id: 'user-function-bound-to-object',
    source: `function frames(a: unknown[], name: string, key: string) { function reader(this: any, k: string) { return this[k]; } const bound = reader.bind(Object); (bound as any)(key); }`,
    changes: true,
  },
  {
    id: 'user-method-called-with-object-as-this',
    source: `function frames(a: unknown[], name: string, key: string) { const helper = { read(this: any, k: string) { return this[k]; } }; (helper.read.call(Object, key) as any)(a, {}); }`,
    changes: true,
  },
  {
    id: 'arrow-called-with-reflect-as-this',
    source: `function frames(a: unknown[], name: string, key: string) { const read = (k: string) => k; read.call(Reflect, key); }`,
    changes: true,
  },
  {
    id: 'user-function-from-a-name-called-with-global-this',
    source: `function frames(a: unknown[], name: string, key: string) { function reader(this: any, k: string) { return this[k]; } reader.call(globalThis, key); }`,
    changes: true,
  },
  {
    id: 'native-called-with-object-as-this-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.assign.call(Object, a, {}); }`,
    changes: true,
  },
  {
    id: 'native-applied-with-object-as-this-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.assign.apply(Object, [a, {}]); }`,
    changes: true,
  },
  {
    id: 'native-bound-to-object-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string) { const assign = Object.assign.bind(Object); assign(a, {}); }`,
    changes: true,
  },
  {
    id: 'native-of-reflect-called-with-reflect-as-this-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Reflect.has.call(Reflect, a, 0); }`,
    changes: true,
  },
  {
    id: 'native-keys-called-with-object-as-this-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.keys.call(Object, a); }`,
    changes: true,
  },
  {
    id: 'native-alias-called-with-object-as-this-is-let-go',
    source: `function frames(a: unknown[], name: string, key: string) { const assign = Object.assign; assign.call(Object, a, {}); }`,
    changes: true,
  },
  {
    id: 'native-called-through-a-function-method-with-object-as-this-is-let-go',
    source: `function frames(a: unknown[], name: string, key: string) { Function.prototype.call.call(Object.assign, Object, a, {}); }`,
    changes: true,
  },
  {
    id: 'user-function-with-object-as-the-this-of-a-bound-call',
    source: `function frames(a: unknown[], name: string, key: string) { function reader(this: any, k: string) { return this[k]; } const run = Function.prototype.call.bind(reader, Object); run(key); }`,
    changes: true,
  },
  {
    id: 'object-as-the-second-argument-of-a-native-call-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.assign.call(null, Object, {}); }`,
    changes: true,
  },
  {
    id: 'user-reader-stored-on-object-called-with-object-as-this-refused',
    source: `function frames(a: unknown[], name: string, key: string) { (Object as any).reader = function (this: any, k: string) { return this[k]; }; const change = (Object as any).reader.call(Object, key); change(a, {}); }`,
    changes: true,
  },
  {
    id: 'user-reader-stored-on-reflect-called-with-reflect-as-this-refused',
    source: `function frames(a: unknown[], name: string, key: string) { (Reflect as any).reader = function (this: any, k: string) { return this[k]; }; const change = (Reflect as any).reader.apply(Reflect, [key]); change(a, {}); }`,
    changes: true,
  },
  {
    id: 'user-member-stored-on-object-and-called-without-this-refused',
    source: `function frames(a: unknown[], name: string, key: string) { (Object as any).helper = () => 1; (Object as any).helper(); }`,
    changes: true,
  },
] as const;

describe('a holder given as the this of a call', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'this-arguments.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
