import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Actual shared helper admission preserves native text concat's coercion boundary. */
describe('shared string concat error words', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      name: 'literal caught argument',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return "".concat(error as never); } }',
      invocation: 'frames()',
      refused: true,
    },
    {
      name: 'bracket caught argument',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return ""["concat"](error as never); } }',
      invocation: 'frames()',
      refused: true,
    },
    {
      name: 'constant text alias',
      source:
        'function frames() { const prefix = "problem: "; try { JSON.parse("bad"); } catch(error) { return prefix.concat(error as never); } }',
      invocation: 'frames()',
      refused: true,
    },
    {
      name: 'explicit string receiver',
      source:
        'function frames(prefix: string, error: Error) { return prefix.concat(error as never); }',
      invocation: 'frames("", new Error("ours"))',
      refused: true,
    },
    {
      name: 'native String receiver',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { return String("").concat(error as never); } }',
      invocation: 'frames()',
      refused: true,
    },
    {
      name: 'array concat keeps error value',
      source: 'function frames(error: Error) { return ([] as unknown[]).concat(error).length; }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'own concat method',
      source:
        'function frames(error: Error) { const own = {concat(value: unknown) { return value === undefined ? "empty" : "data"; }}; return own.concat(error); }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
    {
      name: 'ordinary text argument',
      source: 'function frames() { return "first".concat("second"); }',
      invocation: 'frames()',
      refused: false,
    },
    {
      name: 'locally written error words',
      source: 'function frames() { return "".concat(new Error("ours") as never); }',
      invocation: 'frames()',
      refused: false,
    },
    {
      name: 'shadowed String custom result',
      source:
        'function frames(error: Error) { const String = () => ({concat(value: unknown) { return value === undefined ? "empty" : "data"; }}); return String().concat(error); }',
      invocation: 'frames(new Error("ours"))',
      refused: false,
    },
  ])('$name', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value: string): TodoFilter { return String(${invocation}).length > 40 ? 'all' : value === 'active' || value === 'done' ? value : 'all'; }`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
