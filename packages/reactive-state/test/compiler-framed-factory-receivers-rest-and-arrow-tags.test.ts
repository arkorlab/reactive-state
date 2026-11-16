import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Written-error factory proofs reject mutating or side-effecting declarations and branch prefixes,
 * while preserving pure local holders and non-coercing guards.
 */

const CASES = [
  {
    framed: true,
    id: 'factory-const-object-assign-mutates-message-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const updated = Object.assign(box, { text: String(value) }); return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-const-reflect-set-mutates-message-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const ok = Reflect.set(box, 'text', String(value)); return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-const-define-property-mutates-message-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const updated = Object.defineProperty(box, 'text', { value: String(value) }); return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-const-array-push-mutates-message-list',
    source: `function make(value: unknown) { const items: string[] = []; const count = items.push(String(value)); if (Boolean(count)) return new Error(items[0]); return new Error('fallback'); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-const-property-assignment-expression-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const assigned = (box.text = String(value)); if (Boolean(assigned)) return new Error(box.text); return new Error('fallback'); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-const-helper-call-mutates-message-holder',
    source: `function writeText(target: { text: string }, value: unknown) { target.text = String(value); return true; } function make(value: unknown) { const box = { text: 'fixed' }; const done = writeText(box, value); if (done) return new Error(box.text); return new Error('fallback'); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-const-destructuring-default-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const { tag = Object.assign(box, { text: String(value) }).text }: { tag?: string } = {}; if (Boolean(tag)) return new Error(box.text); return new Error('fallback'); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-if-condition-object-assign-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; if (Object.assign(box, { text: String(value) })) return new Error(box.text); return new Error('fallback'); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-return-comma-operand-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; return (Object.assign(box, { text: String(value) }), new Error(box.text)); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: false,
    id: 'factory-unmutated-const-holder-fixed-words-preserved',
    source: `function make(_value: unknown) { const box = { text: 'fixed' }; return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: false,
    id: 'factory-pure-boolean-guard-and-const-alias-preserved',
    source: `function make(value: unknown) { const alias = value; const present = Boolean(alias); if (present) return new Error('one'); return new Error('two'); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
] as const;

describe('written-error factory side effects, receivers, rest arguments, and arrow tags', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ framed, source }) => {
    expect(readsFrames(api, source)).toBe(framed);
  });
});

function readsFrames(api: API, source: string): boolean {
  using parsed = parseModule(api, 'factory-receivers-rest-and-arrow-tags.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
