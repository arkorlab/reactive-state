import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Computed property names and decorators on nested methods and accessors execute in the enclosing
 * tag function's `arguments` scope rather than the nested callable's own `arguments` scope, while
 * nested non-arrow bodies and parameter defaults keep their own `arguments` binding.
 */

const CASES = [
  {
    framed: true,
    id: 'object-computed-method-name-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { return { [String(arguments[1])]() {} }; } function text(error: Error) { return Object.keys(tag\`\${error}\`)[0] ?? ''; }`,
  },
  {
    framed: true,
    id: 'object-computed-getter-name-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { return { get [String(arguments[1])]() { return 'safe'; } }; } function text(error: Error) { return Object.keys(tag\`\${error}\`)[0] ?? ''; }`,
  },
  {
    framed: true,
    id: 'object-computed-setter-name-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { return { set [String(arguments[1])](_next: string) {} }; } function text(error: Error) { return Object.keys(tag\`\${error}\`)[0] ?? ''; }`,
  },
  {
    framed: true,
    id: 'class-computed-method-name-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { class Box { [String(arguments[1])]() {} } return Object.getOwnPropertyNames(Box.prototype).join(','); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'class-static-computed-getter-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { class Box { static get [String(arguments[1])]() { return 1; } } return Object.getOwnPropertyNames(Box).join(','); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'class-method-decorator-reads-tag-arguments',
    source: `function record(_key: string) { return (_target: unknown, _ctx?: unknown) => {}; } function tag(_strings: TemplateStringsArray, _value: unknown) { class Box { @record(String(arguments[1])) run() {} } return new Box(); } function text(error: Error) { return String(Boolean(tag\`\${error}\`)); }`,
  },
  {
    framed: true,
    id: 'nested-object-inside-arrow-computed-method-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { const make = () => ({ [String(arguments[1])]() {} }); return Object.keys(make())[0] ?? ''; } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'nested-method-body-reads-own-arguments-only',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { const holder = { read(..._items: string[]) { return String(arguments[0]); } }; return holder.read('safe'); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'nested-function-default-parameter-reads-own-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { function inner(_first: string, label = String(arguments[0])) { return label; } return inner('safe'); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'object-static-computed-method-name-ignoring-error',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { return { ['fixed']() { return 'safe'; } }.fixed(); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'tag-own-default-parameter-reads-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown, copy = String(arguments[1])) { return copy; } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-default-parameter-reads-enclosing-tag-arguments',
    source: `function tag(_strings: TemplateStringsArray, _value: unknown) { const read = (copy = String(arguments[1])) => copy; return read(); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
] as const;

describe('tagged template outer arguments reads in computed method names', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tagged-template-computed-names.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(framed);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
