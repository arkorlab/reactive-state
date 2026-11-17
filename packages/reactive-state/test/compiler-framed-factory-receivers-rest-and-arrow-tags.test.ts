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
    framed: true,
    id: 'factory-return-void-nullish-coalescing-operand-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; return void Object.assign(box, { text: String(value) }) ?? new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-return-logical-or-falsy-prefix-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed', setTime: () => 0 }; return Object.assign(box, { text: String(value) }).setTime(Infinity) || new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-return-logical-and-truthy-prefix-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed', setTime: () => 0 }; return !Object.assign(box, { text: String(value) }).setTime(Infinity) && new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-nested-helper-call-argument-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const inner = (_unused: unknown) => new Error(box.text); return inner(Object.assign(box, { text: String(value) })); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-nested-helper-unused-default-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const inner = (_unused = Object.assign(box, { text: String(value) })) => new Error(box.text); return inner(); } function text(externalError: Error) { const local: Error = make([externalError]); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-reflected-object-call-receiver-mutates-holder',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; return Object.call(Object.assign(box, { text: String(value) }), new Error(box.text)); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: false,
    id: 'factory-pure-void-nullish-coalescing-fallback-preserved',
    source: `function make(_value: unknown) { const box = { text: 'fixed' }; return void box.text ?? new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
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
  {
    framed: true,
    id: 'factory-call-receiver-property-smuggles-error-words',
    source: `function make(this: { input: unknown }) { return new Error(String(this.input)); } function text(externalError: Error) { const local: Error = make.call({ input: [externalError] }); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-call-direct-error-receiver-smuggles-words',
    source: `function make(this: unknown) { return new Error(String(this)); } function text(other: Error) { const e: Error = make.call(other); return String(e); }`,
  },
  {
    framed: true,
    id: 'factory-apply-receiver-property-smuggles-error-words',
    source: `function make(this: { input: unknown }) { return new TypeError(String(this.input)); } function text(externalError: Error) { const local: Error = make.apply({ input: [externalError] }, []); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-bind-receiver-property-smuggles-error-words',
    source: `function make(this: { input: unknown }) { return new RangeError(String(this.input)); } function text(externalError: Error) { const local: Error = make.bind({ input: [externalError] })(); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-reflect-apply-receiver-smuggles-error-words',
    source: `function make(this: { input: unknown }) { return new Error(String(this.input)); } function text(externalError: Error) { const local: Error = Reflect.apply(make, { input: [externalError] }, []); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-nested-arrow-inherits-this-receiver',
    source: `function make(this: { input: unknown }) { const read = () => String(this.input); return new Error(read()); } function text(externalError: Error) { const local: Error = make.call({ input: [externalError] }); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-arrow-default-parameter-reads-this-receiver',
    source: `function make(this: { input: unknown }) { const read = (label = String(this.input)) => label; return new Error(read()); } function text(externalError: Error) { const local: Error = make.call({ input: [externalError] }); return local.message; }`,
  },
  {
    framed: true,
    id: 'arrow-factory-inherits-enclosing-this-receiver',
    source: `function host(this: { input: unknown }) { const make = () => new Error(String(this.input)); const local: Error = make(); return String(local); } function text(externalError: Error) { return host.call({ input: [externalError] }); }`,
  },
  {
    framed: true,
    id: 'factory-call-trailing-rest-argument-smuggles-error-words',
    source: `function make(...values: unknown[]) { return new Error(String(values[1])); } function text(externalError: Error) { const local: Error = make.call(null, 'fixed', [externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'factory-bind-trailing-captured-rest-argument-smuggles-words',
    source: `function make(...values: unknown[]) { return new Error(String(values[1])); } function text(externalError: Error) { const local: Error = make.bind(null, 'fixed', [externalError])(); return local.message; }`,
  },
  {
    framed: true,
    id: 'factory-call-extra-positional-arguments-object-smuggles-words',
    source: `function make(_first: string) { return new Error(String(arguments[1])); } function text(externalError: Error) { const local: Error = make.call(null, 'fixed', [externalError]); return String(local); }`,
  },
  {
    framed: false,
    id: 'borrowed-rest-factory-with-all-quiet-primitives-preserved',
    source: `function make(...values: string[]) { return new Error(values[1] ?? 'fixed'); } function text() { const local: Error = make.call(null, 'one', 'two'); return String(local); }`,
  },
  {
    framed: false,
    id: 'bound-factory-with-quiet-captured-and-call-args-preserved',
    source: `function make(first: string, second: string) { return new Error(first + second); } function text() { const local: Error = make.bind(null, 'one')('two'); return local.message; }`,
  },
  {
    framed: false,
    id: 'factory-with-nested-function-binding-own-this-preserved',
    source: `function make() { function inner(this: { tag: string }) { return this.tag; } return new Error(inner.call({ tag: 'fixed' })); } function text() { const local: Error = make(); return String(local); }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-inherited-enclosing-function-arguments',
    source: `function run(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown) => String(arguments[0]); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'inline-arrow-tag-reads-inherited-arguments',
    source: `function run(error: Error) { return ((_s: TemplateStringsArray, _v: unknown) => String(arguments[0]))\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'nested-arrow-inside-arrow-tag-reads-inherited-arguments',
    source: `function run(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown) => (() => String(arguments[0]))(); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-default-parameter-reads-inherited-arguments',
    source: `function run(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown, copy = String(arguments[0])) => copy; return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'method-arrow-tag-reads-inherited-method-arguments',
    source: `class Formatter { render(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown) => String(arguments[0]); return tag\`\${error}\`; } }`,
  },
  {
    framed: true,
    id: 'arrow-tag-computed-method-name-reads-inherited-arguments',
    source: `function run(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown) => Object.keys({ [String(arguments[0])]() {} })[0] ?? ''; return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-arguments-alias',
    source: `function run(error: Error) { const args = arguments; const tag = (_s: TemplateStringsArray, _v: unknown) => String(args[0]); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-indexed-arguments-binding',
    source: `function run(error: Error) { const first = arguments[0]; const tag = (_s: TemplateStringsArray, _v: unknown) => String(first); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-array-destructured-arguments',
    source: `function run(error: Error) { const [first] = Array.from(arguments); const tag = (_s: TemplateStringsArray, _v: unknown) => String(first); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-object-destructured-arguments',
    source: `function run(error: Error) { const { 0: first } = Object.assign({}, arguments); const tag = (_s: TemplateStringsArray, _v: unknown) => String(first); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-spread-arguments-array',
    source: `function run(error: Error) { const rest = [...arguments]; const tag = (_s: TemplateStringsArray, _v: unknown) => String(rest[0]); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-array-from-arguments',
    source: `function run(error: Error) { const copy = Array.from(arguments); const tag = (_s: TemplateStringsArray, _v: unknown) => String(copy[0]); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-reassigned-let-arguments-slot',
    source: `function run(error: Error) { let picked = 'fixed'; picked = String(arguments[0]); const tag = (_s: TemplateStringsArray, _v: unknown) => picked; return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-enclosing-for-of-arguments-item',
    source: `function run(error: Error) { const seen: unknown[] = []; for (const item of arguments) seen.push(item); const tag = (_s: TemplateStringsArray, _v: unknown) => String(seen[0]); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-nested-method-reads-enclosing-arguments-binding',
    source: `function run(error: Error) { const first = arguments[0]; const tag = (_s: TemplateStringsArray, _v: unknown) => ({ read() { return String(first); } }).read(); return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-holder-mutated-through-enclosing-alias',
    source: `function run(error: Error) { const box = { text: 'fixed' }; const alias = box; alias.text = String(arguments[0]); const tag = (_s: TemplateStringsArray, _v: unknown) => box.text; return tag\`\${error}\`; }`,
  },
  {
    framed: true,
    id: 'arrow-tag-reads-holder-filled-by-array-from-arguments-mapper',
    source: `function run(error: Error) { let saved = 'fixed'; Array.from(arguments, (item) => { saved = String(item); return 0; }); const tag = (_s: TemplateStringsArray, _v: unknown) => saved; return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'arrow-tag-ignoring-unrelated-enclosing-arguments-binding-preserved',
    source: `function run(error: Error) { const _unused = arguments[0]; const safe = 'fixed'; const tag = (strings: TemplateStringsArray, _v: unknown) => safe + (strings[0] ?? ''); return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'arrow-tag-with-nested-method-reading-own-arguments-preserved',
    source: `function run(error: Error) { const tag = (_s: TemplateStringsArray, _v: unknown) => ({ read(..._items: string[]) { return String(arguments[0]); } }).read('safe'); return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'arrow-tag-inside-error-function-ignoring-arguments-preserved',
    source: `function run(error: Error) { const tag = (strings: TemplateStringsArray, _v: unknown) => strings[0] ?? ''; return tag\`\${error}\`; }`,
  },
  {
    framed: false,
    id: 'deeply-nested-object-wrappers-in-factory-const-linear-purity-preserved',
    source: `function make(_value: unknown) { const box = { text: 'fixed' }; const _wrapped = ${'Object('.repeat(28)}box${')'.repeat(28)}; return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
  },
  {
    framed: true,
    id: 'deeply-nested-object-wrappers-hiding-mutation-in-factory-const-flagged',
    source: `function make(value: unknown) { const box = { text: 'fixed' }; const _wrapped = ${'Object('.repeat(28)}Object.assign(box, { text: String(value) })${')'.repeat(28)}; return new Error(box.text); } function text(externalError: Error) { const local: Error = make([externalError]); return String(local); }`,
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
