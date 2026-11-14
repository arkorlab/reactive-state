import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A name that reaches a prototype is read where the code writes it whole. A name made of joined texts
 * (a `+` of texts, a template of texts, a constant of such) is not read, nor one the code makes at run
 * time (a parameter, a variable it assigns, a call's answer): the checks do not follow a name assembled
 * to get past them (`AGENTS.md`, "Known limits"). A text joined that is no name, and a prototype named
 * whole beside one, are as they were.
 */
const CASES = [
  {
    id: 'joined-get-prototype-of-of-the-native-compared-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Object['get' + 'PrototypeOf'](a) === null); }`,
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
