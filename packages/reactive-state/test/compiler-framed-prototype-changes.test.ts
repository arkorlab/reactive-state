import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A file may give an array another prototype, whose setter an assignment then meets, where it names
 * `__proto__` or `setPrototypeOf` however it writes the name, or computes a name it does not write: a
 * member of `Object`, `Reflect` or the global object by a key it cannot read, or one of them given to
 * code that can read any member of it.
 */
const HEAD =
  'function frames(error: Error, at: number, name: string, p: object, use: (value: unknown) => void) { const a: unknown[] = [error];';

const CASES = [
  {
    id: 'proto-identifier',
    source: `${HEAD} a.__proto__ = p; return a; }`,
    changes: true,
  },
  {
    id: 'proto-text',
    source: `${HEAD} a['__proto__'] = p; return a; }`,
    changes: true,
  },
  {
    id: 'proto-template',
    source: `${HEAD} a[\`__proto__\`] = p; return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-member',
    source: `${HEAD} Object.setPrototypeOf(a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-text',
    source: `${HEAD} Object['setPrototypeOf'](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-template',
    source: `${HEAD} Object[\`setPrototypeOf\`](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-template-with-substitution',
    source: `${HEAD} Object[\`\${'setPrototypeOf'}\`](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-sum',
    source: `${HEAD} Object['set' + 'PrototypeOf'](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-constant-key',
    source: `${HEAD} const key = 'setPrototypeOf'; Object[key](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-unknown-key',
    source: `${HEAD} Object[name](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-unknown-key',
    source: `${HEAD} Reflect[name](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-text-key',
    source: `${HEAD} Reflect['setPrototypeOf'](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'global-object-unknown-key',
    source: `${HEAD} globalThis[name]; return a; }`,
    changes: true,
  },
  {
    id: 'global-object-then-unknown-key',
    source: `${HEAD} globalThis.Object[name](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'descriptor-of-object-by-name',
    source: `${HEAD} Reflect.apply(Object.getOwnPropertyDescriptor(Object, name)?.value, null, [a, p]); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-get-of-object',
    source: `${HEAD} Reflect.get(Object, name); return a; }`,
    changes: true,
  },
  {
    id: 'alias-of-object-read-by-name',
    source: `${HEAD} const O = Object; O[name](a, p); return a; }`,
    changes: true,
  },
  {
    id: 'object-given-to-a-function',
    source: `${HEAD} use(Object); return a; }`,
    changes: true,
  },
  {
    id: 'object-in-a-list',
    source: `${HEAD} const holders = [Object]; return a; }`,
    changes: true,
  },
  {
    id: 'destructured-by-name',
    source: `${HEAD} const { [name]: change } = Object; return a; }`,
    changes: true,
  },
  {
    id: 'destructured-by-text',
    source: `${HEAD} const { setPrototypeOf } = Object; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-defined',
    source: `${HEAD} Object.defineProperty(Array.prototype, 'join', { set() {} }); return a; }`,
    changes: true,
  },
  {
    id: 'object-prototype-assigned',
    source: `${HEAD} Object.assign(Object.prototype, { set join(value) {} }); return a; }`,
    changes: true,
  },
  {
    id: 'object-as-the-base-of-a-class-refused',
    source: `${HEAD} class Unused extends Object {} return a; }`,
    changes: true,
  },
  {
    id: 'object-as-the-this-of-a-call-refused-pin',
    source: `${HEAD} Object.assign.call(Object, a, {}); return a; }`,
    changes: true,
  },
  {
    id: 'object-in-a-comma-as-the-base-of-a-class-refused',
    source: `${HEAD} class Unused extends ((a.length, Object)) {} return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-assigned',
    source: `${HEAD} Array.prototype.toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-assigned-by-text',
    source: `${HEAD} Array.prototype['toString'] = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-assigned-by-name',
    source: `${HEAD} Array.prototype[name] = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-assigned-compound',
    source: `${HEAD} (Array.prototype as any).toString += 'x'; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-assigned-in-a-pattern',
    source: `${HEAD} [Array.prototype.toString] = [Array.prototype.join]; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-deleted',
    source: `${HEAD} delete (Array.prototype as any).toString; return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-defined',
    source: `${HEAD} Object.defineProperty(Array.prototype, 'toString', { value: Array.prototype.join }); return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-methods-defined',
    source: `${HEAD} Object.defineProperties(Array.prototype, { toString: { value: Array.prototype.join } }); return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-reflect-set',
    source: `${HEAD} Reflect.set(Array.prototype, 'toString', Array.prototype.join); return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-assign',
    source: `${HEAD} Object.assign(Array.prototype, { toString: Array.prototype.join }); return a; }`,
    changes: true,
  },
  {
    id: 'array-prototype-kept-in-a-variable',
    source: `${HEAD} const proto = Array.prototype; (proto as any).toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'object-prototype-method-assigned',
    source: `${HEAD} (Object.prototype as any).toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'function-prototype-method-assigned',
    source: `${HEAD} (Function.prototype as any).call = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'global-array-prototype-method-assigned',
    source: `${HEAD} (globalThis.Array.prototype as any).toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'prototype-of-the-array-method-assigned',
    source: `${HEAD} (Object.getPrototypeOf(a) as any).toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'prototype-of-the-constructor-method-assigned',
    source: `${HEAD} (a.constructor.prototype as any).toString = Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'native-prototype-member-read-refused',
    source: `${HEAD} void Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'native-prototype-member-called-refused',
    source: `${HEAD} Array.prototype.join.call(a); return a; }`,
    changes: true,
  },
  {
    id: 'native-prototype-member-read-by-text-refused',
    source: `${HEAD} void Array.prototype['join']; return a; }`,
    changes: true,
  },
  {
    id: 'native-prototype-member-given-as-a-value-refused',
    source: `${HEAD} Object.assign(a, { join: Array.prototype.join }); return a; }`,
    changes: true,
  },
  {
    id: 'prototype-of-another-class-read-refused-pin',
    source: `${HEAD} class Table {} void Table.prototype; return a; }`,
    changes: true,
  },
  {
    id: 'plain-assignment-pin',
    source: `${HEAD} a.join = () => 'safe'; return a; }`,
    changes: false,
  },
  {
    id: 'assign-pin',
    source: `${HEAD} Object.assign(a, { join: () => 'safe' }); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-object-pin',
    source: `${HEAD} Object.keys(a); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-object-by-text-pin',
    source: `${HEAD} Object['keys'](a); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-object-by-template-pin',
    source: `${HEAD} Object[\`keys\`](a); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-object-by-constant-refused-pin',
    source: `${HEAD} const key = 'keys'; Object[key](a); return a; }`,
    changes: true,
  },
  {
    id: 'object-called-pin',
    source: `${HEAD} Object(a); return a; }`,
    changes: false,
  },
  {
    id: 'object-made-pin',
    source: `${HEAD} new Object(); return a; }`,
    changes: false,
  },
  {
    id: 'object-tested-pin',
    source: `${HEAD} void (a instanceof Object); void typeof Object; return a; }`,
    changes: false,
  },
  {
    id: 'dynamic-index-pin',
    source: `${HEAD} a[at] = 1; return a; }`,
    changes: false,
  },
  {
    id: 'dynamic-index-of-another-object-pin',
    source: `${HEAD} const table: any = {}; table[name] = 1; return a; }`,
    changes: false,
  },
  {
    id: 'sum-that-is-not-a-name-pin',
    source: `${HEAD} const text = 'set' + 'Items'; return a; }`,
    changes: false,
  },
  {
    id: 'template-that-is-not-a-name-pin',
    source: `${HEAD} const text = \`\${name}\`; return a; }`,
    changes: false,
  },
  {
    id: 'prototype-of-a-native-read-refused',
    source: `${HEAD} Array.prototype.join.call(a); return a; }`,
    changes: true,
  },
] as const;

describe('a file that may give an array another prototype', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-changes.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
