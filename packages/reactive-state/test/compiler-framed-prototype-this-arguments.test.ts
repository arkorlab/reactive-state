import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * `Object` given as the `this` of a call of `call`, `apply` or `bind` is not let go where the function
 * is one of the language's own (a member of `Object` or `Reflect`), which reads no member of it by a name
 * it chooses. A function the code writes may read any member of it, `this[key]`, and so may reach
 * `setPrototypeOf`: the holder it is given is let go, whether the function is a declaration, a method, an
 * arrow, a name, or the function a `call` is bound to.
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
    id: 'native-called-with-object-as-this-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.assign.call(Object, a, {}); }`,
    changes: false,
  },
  {
    id: 'native-applied-with-object-as-this-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.assign.apply(Object, [a, {}]); }`,
    changes: false,
  },
  {
    id: 'native-bound-to-object-pin',
    source: `function frames(a: unknown[], name: string, key: string) { const assign = Object.assign.bind(Object); assign(a, {}); }`,
    changes: false,
  },
  {
    id: 'native-of-reflect-called-with-reflect-as-this-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Reflect.has.call(Reflect, a, 0); }`,
    changes: false,
  },
  {
    id: 'native-keys-called-with-object-as-this-pin',
    source: `function frames(a: unknown[], name: string, key: string) { Object.keys.call(Object, a); }`,
    changes: false,
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
] as const;

describe('a holder given as the this of a call', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'this-arguments.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
