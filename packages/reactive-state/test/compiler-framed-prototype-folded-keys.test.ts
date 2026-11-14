import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A name that reaches a prototype is a mention where the code writes it as text alone, not only as
 * one text: a `+` of texts, a template whose substitutions are texts, a constant of such, folded
 * before the name is looked up. A name the code makes at run time (a parameter, a variable it
 * assigns, a call's answer) is not written, and is not read.
 */
const CASES = [
  {
    id: 'joined-proto-key-of-an-array-write-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)['__pro' + 'to__'] = p; }`,
    changes: true,
  },
  {
    id: 'joined-proto-key-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[('__pro' + 'to') + '__'] = p; }`,
    changes: true,
  },
  {
    id: 'joined-proto-key-through-a-cast-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[<string>'__pro' + <string>'to__'] = p; }`,
    changes: true,
  },
  {
    id: 'joined-proto-key-through-satisfies-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[('__pro' satisfies string) + 'to__'] = p; }`,
    changes: true,
  },
  {
    id: 'template-of-texts-proto-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[\`__pro\${'to'}__\`] = p; }`,
    changes: true,
  },
  {
    id: 'template-with-a-constant-substitution-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const part = 'to'; (a as any)[\`__pro\${part}__\`] = p; }`,
    changes: true,
  },
  {
    id: 'joined-constants-proto-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const head = '__pro'; const tail = 'to__'; (a as any)[head + tail] = p; }`,
    changes: true,
  },
  {
    id: 'constant-of-a-join-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const name = '__pro' + 'to__'; (a as any)[name] = p; }`,
    changes: true,
  },
  {
    id: 'constant-of-a-constant-of-a-join-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const first = '__pro'; const second = first + 'to'; const name = second + '__'; void name; }`,
    changes: true,
  },
  {
    id: 'joined-set-prototype-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { helper['set' + 'PrototypeOf'](a, p); }`,
    changes: true,
  },
  {
    id: 'joined-get-prototype-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { helper['get' + 'PrototypeOf'](a); }`,
    changes: true,
  },
  {
    id: 'joined-get-prototype-of-of-the-native-compared-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Object['get' + 'PrototypeOf'](a) === null); }`,
    changes: true,
  },
  {
    id: 'joined-define-setter-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)['__define' + 'Setter__']('join', () => 1); }`,
    changes: true,
  },
  {
    id: 'joined-define-getter-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[\`__define\${'Getter'}__\`]('join', () => 1); }`,
    changes: true,
  },
  {
    id: 'joined-lookup-getter-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a as any)['__lookup' + 'Getter__']('join'); }`,
    changes: true,
  },
  {
    id: 'joined-lookup-setter-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a as any)['__lookup' + 'Setter__']('join'); }`,
    changes: true,
  },
  {
    id: 'joined-prototype-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (helper['proto' + 'type']); }`,
    changes: true,
  },
  {
    id: 'joined-constructor-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (helper['const' + 'ructor']); }`,
    changes: true,
  },
  {
    id: 'joined-key-of-a-literal-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void { ['__pro' + 'to__']: p }; }`,
    changes: true,
  },
  {
    id: 'joined-key-of-a-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const { ['get' + 'PrototypeOf']: reach } = helper; void reach; }`,
    changes: true,
  },
  {
    id: 'joined-key-of-a-class-member-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { class Table { ['const' + 'ructor']() {} } void Table; }`,
    changes: true,
  },
  {
    id: 'joined-key-on-the-object-prototype-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (Object.prototype as any)['__define' + 'Setter__'].call(a, 'join', () => 1); }`,
    changes: true,
  },
  {
    id: 'joined-key-of-a-delete-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { delete (Array.prototype as any)['proto' + 'type']; }`,
    changes: true,
  },
  {
    id: 'joined-names-in-a-template-tag-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void String.raw\`x\${'__pro' + 'to__'}\`; }`,
    changes: true,
  },
  {
    id: 'joined-text-that-is-no-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('jo' + 'in'); }`,
    changes: false,
  },
  {
    id: 'joined-text-in-a-key-that-is-no-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)['jo' + 'in'] = p; }`,
    changes: false,
  },
  {
    id: 'template-that-is-no-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const part = 'jo'; void \`\${part}in\`; }`,
    changes: false,
  },
  {
    id: 'joined-number-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (1 + 2); }`,
    changes: false,
  },
  {
    id: 'joined-text-and-a-number-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('x' + 1); }`,
    changes: false,
  },
  {
    id: 'template-with-a-runtime-substitution-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a as any)[\`__pro\${key}\`]; }`,
    changes: false,
  },
  {
    id: 'join-of-a-runtime-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a as any)[key + 'to__']; }`,
    changes: false,
  },
  {
    id: 'runtime-key-of-a-parameter-not-covered-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)[key] = p; }`,
    changes: false,
  },
  {
    id: 'shadowed-constant-is-a-runtime-name-not-covered-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const head = '__pro'; function inner(head: string) { (a as any)[head + 'to__'] = p; } void inner; void head; }`,
    changes: false,
  },
  {
    id: 'constants-that-refer-to-each-other-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const first: string = second + 'x'; const second: string = first + 'y'; void first; }`,
    changes: false,
  },
] as const;

describe('a file whose joined texts make a name that reaches a prototype', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-folded-keys.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
