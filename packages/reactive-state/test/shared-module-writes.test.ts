import { describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import type { HookDefinition } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { authorityVisitor, browserVisitor, Collected } from '../src/compiler/reads.ts';
import { walk } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A module of the application's that runs anywhere alike, which the server part imports and writes:
 * the authority runs the server part in its own copy of the module, which every session shares, so
 * a value written there stays for the next render of any. The write is refused where the server part
 * reads the module, and what only reads it, copies it, or hands it to a function, is taken as it
 * was. The browser's code runs in the browser, which has a copy of its own.
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

const SHARED_MODULE = '@/domain/defaults';

/** The part of what the compile says that names the cause, whichever import is written. */
const SAYS =
  "a shared module of the application's, and the authority runs this code in its own copy";

/** A component whose server part is `body`, and whose JSX is `jsx`, which the browser runs. */
function sourceOf(body: string, jsx: string, imported = '{ defaults, helper }'): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    `import ${imported} from '${SHARED_MODULE}';`,
    "import { loadInto } from '@/lib/load';",
    '',
    'export default function Lab({ first }: { first: number }) {',
    ...body.split('\n').map((line) => `  ${line}`),
    '  const [value, setValue] = useReactiveState(first);',
    `  return ${jsx};`,
    '}',
    '',
  ].join('\n');
}

/** Why a compile of `source` refuses its server part, or its JSX where the browser runs it. */
function reasonOf(source: string, side: 'authority' | 'browser'): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'lab.reactive.tsx', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, 'lab.reactive.tsx');
  try {
    const component = analyzeComponent({
      classify: (specifier) => {
        return {
          file: undefined,
          id: undefined,
          kind: specifier === SHARED_MODULE ? 'shared' : 'server',
        };
      },
      fail,
      fileName: 'lab.reactive.tsx',
      hookOf: (binding) => HOOKS[binding.exported],
      id: 'lab',
      sourceFile,
    });
    const state = {
      actions: new Map(),
      authority: new Collected(),
      browser: new Collected(),
      component,
      components: new Map(),
      elements: new Map(),
      fail,
      file: 'lab.reactive.tsx',
      libraries: new Set<string>(),
      modules,
      serverFunctions: new Set<string>(),
      siteElements: [],
      slots: [],
    };
    const names = {
      declared: component.declared,
      declaring: component.declaring,
      topLevel: new Set(component.names.keys()),
    };
    if (side === 'authority') {
      for (const statement of component.server) {
        walk(statement, names, authorityVisitor(state, false), fail);
      }
    } else if (component.returned !== undefined) {
      walk(component.returned, names, browserVisitor(state), fail);
    }
    return undefined;
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return error.reason;
    }
    throw error;
  }
}

const VIEW = '<p>{String(value)}</p>';

describe('a server part that writes an export of a shared module', () => {
  it.each([
    { id: 'an assignment to a member', body: 'defaults.value = first;' },
    { id: 'a compound assignment', body: 'defaults.value += first;' },
    { id: 'a logical assignment', body: 'defaults.value ??= first;' },
    { id: 'an increment', body: 'defaults.value++;' },
    { id: 'a prefix decrement', body: '--defaults.value;' },
    { id: 'a delete', body: 'delete defaults.value;' },
    { id: 'an assignment to a member of a member', body: 'defaults.items[0] = first;' },
    { id: 'a method of arrays that pushes', body: 'defaults.items.push(first);' },
    { id: 'a method of arrays that sorts', body: 'defaults.items.sort();' },
    {
      id: 'Object.assign with it as the target',
      body: 'Object.assign(defaults, { value: first });',
    },
    {
      id: 'Object.defineProperty',
      body: "Object.defineProperty(defaults, 'value', { value: first });",
    },
    { id: 'a parenthesised target', body: '(defaults).value = first;' },
    { id: 'a non-null target', body: 'defaults!.value = first;' },
  ])('refuses $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
    expect(reason).toContain(`\`defaults\` is \`${SHARED_MODULE}\`'s`);
  });

  it.each([
    {
      id: 'a cast before a member assigned',
      body: '(defaults as { value: number }).value = first;',
    },
    { id: 'a cast of a member before a push', body: '(defaults.items as number[]).push(first);' },
    {
      id: 'a satisfies before a member assigned',
      body: '(defaults satisfies { value: number }).value = first;',
    },
    {
      id: 'a satisfies of a member before a sort',
      body: '(defaults.items satisfies number[]).sort();',
    },
    {
      id: 'a cast as the target of Object.assign',
      body: 'Object.assign(defaults as object, { first });',
    },
    {
      id: 'two casts before an increment',
      body: '(defaults as unknown as { value: number }).value++;',
    },
  ])('refuses a write through a type assertion: $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
    expect(reason).toContain(`\`defaults\` is \`${SHARED_MODULE}\`'s`);
  });

  it.each([
    { id: 'a Map set', body: "defaults.set('title', first);" },
    { id: 'a Set add', body: 'defaults.add(first);' },
    { id: 'a Map delete', body: 'defaults.delete(first);' },
    { id: 'a Map clear', body: 'defaults.clear();' },
    { id: 'a date setter of a member', body: 'defaults.at.setTime(first);' },
    {
      id: 'an append to search parameters',
      body: "defaults.params.append('page', String(first));",
    },
    { id: 'Reflect.set', body: "Reflect.set(defaults, 'value', first);" },
    { id: 'a push borrowed with call', body: 'defaults.items.push.call(defaults.items, first);' },
    { id: 'a loop that writes a member', body: 'for (defaults.value of [first]) {}' },
    { id: 'Object.freeze', body: 'Object.freeze(defaults);' },
  ])('refuses a method or a function that changes what it is given: $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
  });

  it('says what to write instead', () => {
    expect(reasonOf(sourceOf('defaults.value = first;', VIEW), 'authority')).toContain(
      'Copy it deeply — `const mine = structuredClone(defaults)` — and write the copy, or keep the value in a state.',
    );
  });

  it.each([
    { id: 'a read', body: 'const shown = defaults.value;' },
    { id: 'a copy that is written', body: 'const mine = { ...defaults };\nmine.value = first;' },
    { id: 'a handing to a function of the server', body: 'loadInto(defaults);' },
    {
      id: 'an Object.assign into a copy',
      body: 'const mine = Object.assign({}, defaults);\nmine.value = first;',
    },
    { id: 'JSON.stringify', body: 'const text = JSON.stringify(defaults);' },
    { id: 'a function of the module', body: 'const next = helper(first);' },
    {
      id: 'a copy of a member that is pushed to',
      body: 'const items = [...defaults.items];\nitems.push(first);',
    },
    { id: 'a copy that is sorted', body: 'const sorted = defaults.items.slice().sort();' },
    { id: 'a map', body: 'const doubled = defaults.items.map((item) => item * 2);' },
    {
      id: 'an Object.assign with it as a source',
      body: 'const merged = Object.assign({ first }, defaults);',
    },
    {
      id: 'an object of its own that is written',
      body: 'const own = { value: first };\nown.value = 2;',
    },
  ])('takes $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW), 'authority')).toBeUndefined();
  });

  it.each([
    { id: 'a Map get', body: 'const found = defaults.get(first);' },
    { id: 'a Map has', body: 'const found = defaults.has(first);' },
    {
      id: 'the entries of a Map spread into an array',
      body: 'const rows = [...defaults.entries()];',
    },
    { id: 'a copy of a Map that is set', body: "new Map(defaults).set('title', first);" },
    {
      id: 'a structured clone that is pushed to',
      body: 'structuredClone(defaults).items.push(first);',
    },
    {
      id: 'the copy the refusal advises, a member pushed to',
      body: 'const mine = structuredClone(defaults);\nmine.items.push(first);',
    },
    {
      id: 'the copy the refusal advises, a member assigned',
      body: 'const mine = structuredClone(defaults);\nmine.value = first;',
    },
    {
      id: 'a member read through a cast',
      body: 'const shown = (defaults as { value: number }).value;',
    },
    { id: 'a member searched', body: 'const found = defaults.items.includes(first);' },
    { id: 'a member looped over', body: 'for (const item of defaults.items) { String(item); }' },
  ])('takes what only reads it, through a cast or not: $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW), 'authority')).toBeUndefined();
  });

  it.each([
    { id: 'add', body: 'const sum = defaults.add(1, 2);' },
    { id: 'set', body: "const stored = defaults.set('title', first);" },
    { id: 'delete', body: 'const gone = defaults.delete(first);' },
    { id: 'clear', body: 'const cleared = defaults.clear();' },
    { id: 'append', body: 'const added = defaults.append(first);' },
    { id: 'push', body: 'const pushed = defaults.push(first);' },
    { id: 'sort', body: 'const sorted = defaults.sort();' },
    { id: 'a receiver in parentheses', body: 'const sum = (defaults).add(1, 2);' },
    { id: 'a receiver with a non-null assertion', body: 'const sum = defaults!.add(1, 2);' },
    { id: 'a receiver cast', body: 'const sum = (defaults as typeof defaults).add(1, 2);' },
    { id: 'a name in brackets', body: "const sum = defaults['add'](1, 2);" },
  ])('takes a call of an export of a namespace import, $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW, '* as defaults'), 'authority')).toBeUndefined();
  });

  it.each([
    { id: 'a push to a member', body: 'defaults.items.push(first);' },
    { id: 'a sort of a member', body: 'defaults.items.sort();' },
    { id: 'a set of a member', body: "defaults.registry.set('title', first);" },
    { id: 'an increment of a member of a member', body: 'defaults.config.count++;' },
    { id: 'an assignment to a member of a member', body: 'defaults.total.value = first;' },
    { id: 'Object.assign into a member', body: 'Object.assign(defaults.config, { first });' },
    { id: 'an increment of a member', body: 'defaults.count++;' },
    { id: 'an assignment to a member', body: 'defaults.count = first;' },
    { id: 'a delete of a member', body: 'delete defaults.config;' },
    { id: 'a push to a member through a cast', body: '(defaults.items as number[]).push(first);' },
  ])('refuses a write of a member of a namespace import: $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW, '* as defaults'), 'authority');

    expect(reason).toContain(SAYS);
    expect(reason).toContain(`\`defaults\` is \`${SHARED_MODULE}\`'s`);
  });

  it.each([
    {
      id: 'a transfer list of the import and a member',
      body: 'structuredClone(defaults, { transfer: [defaults.buffer] });',
    },
    {
      id: 'a transfer list of a member alone',
      body: 'structuredClone(first, { transfer: [defaults.buffer] });',
    },
    {
      id: 'a transfer list of a member through a cast',
      body: 'structuredClone(first, { transfer: [defaults.buffer as ArrayBuffer] });',
    },
    {
      id: 'a dispatch of an event it holds',
      body: 'new EventTarget().dispatchEvent(defaults.event);',
    },
  ])('refuses a write into it that a call makes beside its receiver: $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
  });

  it.each([
    { id: 'a structured clone alone', body: 'const copy = structuredClone(defaults);' },
    {
      id: 'a structured clone of a member with an empty transfer list',
      body: 'const copy = structuredClone(defaults.items, { transfer: [] });',
    },
    {
      id: 'a transfer list of a buffer of its own',
      body: 'const own = new ArrayBuffer(8);\nconst copy = structuredClone(own, { transfer: [own] });',
    },
    {
      id: 'a structured clone of a member with other options',
      body: 'const copy = structuredClone(defaults.items, { transfer: [], extra: defaults.value });',
    },
    {
      id: 'a dispatch of an event of its own',
      body: "new EventTarget().dispatchEvent(new Event('ready'));",
    },
    {
      id: 'a dispatch of an event built of a member',
      body: 'new EventTarget().dispatchEvent(new Event(defaults.name));',
    },
  ])('takes what a call writes into that is no part of it: $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW), 'authority')).toBeUndefined();
  });

  it.each([
    { id: 'an array pattern', body: '[defaults.value] = [first];' },
    { id: 'an object pattern', body: '({ value: defaults.value } = { value: first });' },
    {
      id: 'members of members in an array pattern',
      body: '[defaults.items[0], defaults.value] = [first, first];',
    },
    { id: 'a pattern within a pattern', body: '({ a: [defaults.value] } = { a: [first] });' },
    { id: 'a rest element', body: '[...defaults.items] = [first];' },
    { id: 'an element with a default', body: '[defaults.value = 0] = [first];' },
    { id: 'a pattern as the target of a loop', body: 'for ([defaults.value] of [[first]]) {}' },
    { id: 'a cast in a pattern', body: '[(defaults as { value: number }).value] = [first];' },
  ])('refuses a write of the import as a target of a pattern: $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
  });

  it.each([
    {
      id: 'the import read on the right',
      body: 'let a = 0;\nlet b = 0;\n[a, b] = [defaults.value, defaults.value];',
    },
    { id: 'the import as the value destructured', body: 'let a = 0;\n({ a } = defaults);' },
    { id: 'the import as a default', body: 'let a = 0;\n[a = defaults.value] = [first];' },
    { id: 'a declaration of a pattern', body: 'const { value: shown } = defaults;' },
    { id: 'an array that holds a member', body: 'const list = [defaults.value, first];' },
    {
      id: 'a key a pattern computes',
      body: 'let key = 0;\n({ [defaults.name]: key } = { n: first });',
    },
    {
      id: 'a copy spread into an array that is written',
      body: 'const [head] = [...defaults.items];\nlet own = head;\nown = first;',
    },
  ])('takes a pattern that only reads the import: $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW), 'authority')).toBeUndefined();
  });

  it('takes a write the browser runs, which has a copy of its own', () => {
    const jsx = [
      '<button type="button" onClick={() => { defaults.value = 1; setValue(value + 1); }}>',
      '{String(value)}',
      '</button>',
    ].join('');

    expect(reasonOf(sourceOf('', jsx), 'browser')).toBeUndefined();
  });
});
