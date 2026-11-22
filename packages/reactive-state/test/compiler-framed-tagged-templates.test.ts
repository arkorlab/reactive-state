import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Tagged templates pass their substitutions unchanged to the tag rather than coercing them to
 * strings first: source-written tags that do not coerce or forward an error substitution stay
 * accepted, while `String.raw`, unknown tags, and coercing or forwarding tags remain refused.
 */

const CASES = [
  {
    framed: false,
    id: 'source-function-tag-ignores-error',
    source: `function ignore(_strings: TemplateStringsArray, _value: unknown) { return 'safe'; } function text(error: Error) { return ignore\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'const-arrow-tag-ignores-error-array',
    source: `const ignore = (_strings: TemplateStringsArray, _value: unknown) => 'safe'; function text(error: Error) { return ignore\`\${[error]}\`; }`,
  },
  {
    framed: false,
    id: 'inline-arrow-tag-without-substitution-params',
    source: `function text(error: Error) { return ((strings: TemplateStringsArray) => strings[0] ?? '')\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'source-tag-strict-nullish-guard',
    source: `const check = (_strings: TemplateStringsArray, value: unknown) => (value === undefined ? 'empty' : 'present'); function text(error: Error) { return check\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'source-tag-coerces-first-ignores-second-error',
    source: `function head(_strings: TemplateStringsArray, label: string, _unused: unknown) { return String(label); } function text(error: Error) { return head\`\${'ok'}\${error}\`; }`,
  },
  {
    framed: true,
    id: 'string-raw-tag-direct-error',
    source: `function text(error: Error) { return String.raw\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'string-raw-tag-error-array',
    source: `function text(error: Error) { return String.raw\`\${[error]}\`; }`,
  },
  {
    framed: true,
    id: 'aliased-string-raw-tag',
    source: `function text(error: Error) { const raw = String.raw; return raw\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'source-tag-coercing-substitution',
    source: `const format = (_strings: TemplateStringsArray, value: unknown) => String(value); function text(error: Error) { return format\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'source-tag-returning-substitution-into-string',
    source: `const forward = (_strings: TemplateStringsArray, value: unknown) => value; function text(error: Error) { return String(forward\`\${error}\`); }`,
  },
  {
    framed: true,
    id: 'reassigned-function-tag',
    source: `function text(error: Error) { function tag(_s: TemplateStringsArray, _v: unknown) { return 'safe'; } tag = String.raw as never; return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'unknown-parameter-tag',
    source: `function text(tag: (strings: TemplateStringsArray, value: unknown) => string, error: Error) { return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'string-raw-locally-made-error',
    source: `function text() { return String.raw\`\${new Error('ours')}\`; }`,
  },
  {
    framed: true,
    id: 'untagged-template-error',
    source: `function text(error: Error) { return \`\${error}\`; }`,
  },
] as const;

describe('tagged template error substitutions', () => {
  it.each(CASES)('$id', ({ framed, source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tagged-templates.ts', source);

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
