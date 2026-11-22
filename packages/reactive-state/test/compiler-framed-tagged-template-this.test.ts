import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * TypeScript erases an explicit leading `this` parameter at run time, so tagged-template slot
 * checks must index `parametersOf(fn)` rather than raw `fn.parameters`.
 */

const CASES = [
  {
    framed: true,
    id: 'this-param-function-tag-coercing-substitution',
    source: `function tag(this: void, _strings: TemplateStringsArray, value: unknown) { return String(value); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'this-param-function-tag-coercing-error-array',
    source: `function tag(this: void, _strings: TemplateStringsArray, value: unknown) { return String(value); } function text(error: Error) { return tag\`\${[error]}\`; }`,
  },
  {
    framed: true,
    id: 'this-param-rest-substitutions-coerced',
    source: `function tag(this: void, _strings: TemplateStringsArray, ...values: unknown[]) { return String(values[0]); } function text(error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'this-param-const-function-expression-forwarding',
    source: `const forward = function (this: unknown, _strings: TemplateStringsArray, value: unknown) { return value; }; function text(error: Error) { return String(forward\`\${error}\`); }`,
  },
  {
    framed: true,
    id: 'this-param-second-slot-coerced-first-ignored',
    source: `function tag(this: void, _strings: TemplateStringsArray, _first: unknown, second: unknown) { return String(second); } function text(error: Error) { return tag\`\${'ok'}\${error}\`; }`,
  },
  {
    framed: true,
    id: 'conditional-tag-with-this-coercing-branch',
    source: `function safe(this: void, _s: TemplateStringsArray, _v: unknown) { return 'ok'; } function unsafe(this: void, _s: TemplateStringsArray, v: unknown) { return String(v); } function text(cond: boolean, error: Error) { return (cond ? safe : unsafe)\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'this-param-reads-strings-ignores-error-slot',
    source: `function head(this: void, strings: TemplateStringsArray, _unused: unknown) { return strings.join(''); } function text(error: Error) { return head\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'this-param-strict-equality-guard-with-strings-read',
    source: `function check(this: void, strings: TemplateStringsArray, value: unknown) { return value === undefined ? (strings[0] ?? '') : 'present'; } function text(error: Error) { return check\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'this-param-unread-rest-with-strings-read',
    source: `function ignoreAll(this: void, strings: TemplateStringsArray, ..._values: unknown[]) { return strings[0] ?? ''; } function text(error: Error) { return ignoreAll\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'this-param-function-tag-ignores-all-params',
    source: `function ignore(this: void, _strings: TemplateStringsArray, _value: unknown) { return 'safe'; } function text(error: Error) { return ignore\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'this-param-locally-made-error-coerced',
    source: `function tag(this: void, _strings: TemplateStringsArray, value: unknown) { return String(value); } function text() { return tag\`\${new Error('ours')}\`; }`,
  },
] as const;

describe('tagged template functions with explicit this parameters', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tagged-template-this.ts', source);

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
