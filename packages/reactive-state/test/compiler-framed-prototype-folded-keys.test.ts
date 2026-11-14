import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A name that reaches a prototype is a mention where the code writes it as text alone, not only as
 * one text: a `+` of texts, a template whose substitutions are texts, a constant of such, folded
 * before the name is looked up. A name the code makes at run time (a parameter, a variable it
 * assigns, a call's answer) is not written, and is not read. The folding is bounded: it stops where
 * the text is longer than any such name, and where it has read more parts than it may (an expression
 * that takes more is taken for a name), so that constants that repeat one another stay cheap.
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
  {
    id: 'constant-templates-repeating-a-text-do-not-stall-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const c0 = 'x'; const c1 = \`\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\`; const c2 = \`\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\`; const c3 = \`\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\`; const c4 = \`\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\`; void c4; }`,
    changes: false,
  },
  {
    id: 'constant-templates-repeating-an-empty-text-exhaust-the-budget-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const c0 = ''; const c1 = \`\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\`; const c2 = \`\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\`; const c3 = \`\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\`; void c3; }`,
    changes: true,
  },
  {
    id: 'constant-templates-repeating-an-empty-text-eight-deep-exhaust-the-budget-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const c0 = ''; const c1 = \`\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\${c0}\`; const c2 = \`\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\${c1}\`; const c3 = \`\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\${c2}\`; const c4 = \`\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\${c3}\`; const c5 = \`\${c4}\${c4}\${c4}\${c4}\${c4}\${c4}\${c4}\${c4}\${c4}\${c4}\`; const c6 = \`\${c5}\${c5}\${c5}\${c5}\${c5}\${c5}\${c5}\${c5}\${c5}\${c5}\`; const c7 = \`\${c6}\${c6}\${c6}\${c6}\${c6}\${c6}\${c6}\${c6}\${c6}\${c6}\`; const c8 = \`\${c7}\${c7}\${c7}\${c7}\${c7}\${c7}\${c7}\${c7}\${c7}\${c7}\`; void c8; }`,
    changes: true,
  },
  {
    id: 'constant-templates-of-a-few-empty-texts-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const c0 = ''; const c1 = \`\${c0}\${c0}\${c0}\`; const c2 = \`\${c1}\${c1}\${c1}\`; const c3 = \`\${c2}\${c2}\${c2}\`; void c3; }`,
    changes: false,
  },
  {
    id: 'name-followed-by-a-long-text-is-no-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('__pro' + 'to__ and some more text'); }`,
    changes: false,
  },
  {
    id: 'name-of-single-characters-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)['_' + '_' + 'd' + 'e' + 'f' + 'i' + 'n' + 'e' + 'S' + 'e' + 't' + 't' + 'e' + 'r' + '_' + '_'](1); }`,
    changes: true,
  },
  {
    id: 'name-of-single-characters-nested-to-the-right-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { (a as any)['_' + ('_' + ('d' + ('e' + ('f' + ('i' + ('n' + ('e' + ('S' + ('e' + ('t' + ('t' + ('e' + ('r' + ('_' + '_')))))))))))))](1); }`,
    changes: true,
  },
  {
    id: 'name-through-thirty-constants-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const h0 = '__pro'; const h1 = h0; const h2 = h1; const h3 = h2; const h4 = h3; const h5 = h4; const h6 = h5; const h7 = h6; const h8 = h7; const h9 = h8; const h10 = h9; const h11 = h10; const h12 = h11; const h13 = h12; const h14 = h13; const h15 = h14; const h16 = h15; const h17 = h16; const h18 = h17; const h19 = h18; const h20 = h19; const h21 = h20; const h22 = h21; const h23 = h22; const h24 = h23; const h25 = h24; const h26 = h25; const h27 = h26; const h28 = h27; const h29 = h28; const h30 = h29; (a as any)[h30 + 'to__'] = p; }`,
    changes: true,
  },
  {
    id: 'chain-of-three-hundred-parts-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (key + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a'); }`,
    changes: true,
  },
  {
    id: 'chain-of-three-hundred-texts-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a'); }`,
    changes: true,
  },
  {
    id: 'chain-of-forty-texts-no-name-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a' + 'a'); }`,
    changes: false,
  },
  {
    id: 'long-text-joined-first-and-unknown-later-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ('a long text, longer than any name ' + key); }`,
    changes: false,
  },
  {
    id: 'constant-that-names-itself-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const self: string = self + 'x'; void self; }`,
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
