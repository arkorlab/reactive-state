import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { counting } from '../src/compiler/counting.ts';
import { spliced } from '../src/compiler/splice.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { node } from './fixtures/application.ts';

/** Application methods whose reads and arguments record their exact evaluation order. */
const SETUP = `
const events = [];
const receiver = {
  label: 'original',
  get run() {
    events.push('get');
    return function (value) { events.push(this.label); return value; };
  },
};
const missing = null;
const noncallable = { run: 1 };
const value = 'run';
function key() { events.push('key'); return 'run'; }
function argument() { events.push('argument'); return 'result'; }
function replace() {
  events.push('argument');
  Object.defineProperty(receiver, 'run', { value() { return 'replaced'; } });
  return 'result';
}
`;

/** The scope's capture contract, without imposing policy on the application's methods. */
const SCOPE = `const $ = {
  counted: (value) => value,
  member: (key) => key,
  method: (receiver, key) => {
    const fn = receiver[key];
    return (...args) => Reflect.apply(fn, receiver, args);
  },
};`;

describe('counting method calls', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each([
    'receiver.run(argument())',
    'receiver[key()](argument())',
    'receiver?.[value](argument())',
    'receiver.run(replace())',
    '(receiver.run)(argument())',
    '(receiver.run as (value: string) => string)(argument())',
    '(receiver.run!)(argument())',
    'receiver.run<string>(argument())',
    'receiver?.run(argument())',
    'receiver?.run(argument()).slice(0)',
    'receiver.run(argument())?.slice(0).concat("!")',
    'missing?.run(argument())',
    'missing?.[key()](argument()).slice(0)',
    '(missing?.run)(argument())',
    '(missing?.run)!(argument())',
    '(missing?.run as (value: string) => string)(argument())',
    '(missing?.run)?.value',
    'missing.run(argument())',
    'noncallable.run(argument())',
  ])('preserves receiver, callee and argument evaluation: %s', (expression) => {
    const original = scriptOf(expression);
    using parsed = parseModule(api, 'counted.ts', original);
    const rewritten = spliced(
      parsed.sourceFile,
      parsed.sourceFile,
      counting(parsed.sourceFile, () => {
        // Names remain as the source wrote them.
      }),
    );
    const plain = api.transpileModule(original).outputText;
    const guarded = api.transpileModule(rewritten).outputText;
    const expected = node(`${SETUP}\n${plain}`, process.cwd());
    const actual = node(`${SETUP}\n${SCOPE}\n${guarded}`, process.cwd());

    expect(expected.stderr).toBe('');
    expect(actual.stderr).toBe('');
    expect(actual.stdout).toBe(expected.stdout);
  });
});

/** The result and all effects of evaluating one expression, including a thrown call. */
function scriptOf(expression: string): string {
  return `let result;
try { result = ${expression}; } catch (error) { result = error.name; }
process.stdout.write(JSON.stringify({ events, result }));`;
}
