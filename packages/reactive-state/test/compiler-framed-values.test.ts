import { describe, expect, it } from 'vitest';

import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Actual shared helper admission follows written error values without executing factories. */
describe('shared written error values', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    {
      name: 'as assertion',
      source: 'function frames(value: unknown) { return (value as Error).stack; }',
      refused: true,
      invocation: 'frames(new Error("ours"))',
    },
    {
      name: 'asserted nested member',
      source: 'function frames(value: unknown) { return (value as {error: Error}).error.stack; }',
      refused: true,
      invocation: 'frames({error:new Error("ours")})',
    },
    {
      name: 'asserted destructuring',
      source: 'function frames(value: unknown) { const {stack} = value as Error; return stack; }',
      refused: true,
      invocation: 'frames(new Error("ours"))',
    },
    {
      name: 'caught parenthesized initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = (error); return message; } }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'caught nonnull initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = error!; return message; } }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'caught asserted initializer',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { const {message} = error as Error; return message; } }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'arrow IIFE result',
      source: 'function frames() { return (() => new Error("ours"))().stack; }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'local declaration result',
      source:
        'function make() { return new Error("ours"); } function frames() { return make().stack; }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'local result alias',
      source:
        'function make() { const result = new Error("ours"); return result; } function frames() { const result = make(); return result.stack; }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'plain asserted stack',
      source: 'function frames(value: unknown) { return (value as {stack: string}).stack; }',
      refused: false,
      invocation: 'frames({stack:"data"})',
    },
    {
      name: 'factory ordinary data',
      source:
        'function make() { return {stack:"data"}; } function frames() { return make().stack; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'factory lexical shadow',
      source:
        'function make() { return new Error("ours"); } function frames() { const make = () => ({stack:"data"}); return make().stack; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'created asserted words',
      source: 'function frames() { return (new Error("ours") as Error).message; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'factory written words',
      source:
        'function make() { return new Error("ours"); } function frames() { return make().message; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'asserted factory written words',
      source:
        'function make() { return new Error("ours"); } function frames() { return (make() as Error).message; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'case factory result',
      source:
        'function frames(flag: boolean) { switch(flag) { case true: function make() { return new Error("ours"); } return make().stack; default: return "data"; } }',
      refused: true,
      invocation: 'frames(true)',
    },
    {
      name: 'case asserted alias',
      source:
        'function frames(value: unknown, flag: boolean) { switch(flag) { case true: const error = value as Error; return error.stack; default: return "data"; } }',
      refused: true,
      invocation: 'frames(new Error("ours"), true)',
    },
    {
      name: 'reassigned factory parameter words',
      source:
        'function frames(error: Error) { function make() { return new Error("fixed"); } make = () => error; return (make() as Error).message; }',
      refused: true,
      invocation: 'frames(new Error("ours"))',
    },
    {
      name: 'reassigned factory caught words',
      source:
        'function frames() { try { JSON.parse("bad"); } catch(error) { function make() { return new Error("fixed"); } make = () => error as Error; return (make() as Error).message; } }',
      refused: true,
      invocation: 'frames()',
    },
    {
      name: 'reassigned factory plain data',
      source:
        'function frames() { function make() { return new Error("fixed"); } make = () => ({name:"data",message:"data"}); return make().message; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'reassigned factory own words',
      source:
        'function frames() { function make() { return {name:"data",message:"data"}; } make = () => new Error("ours"); return make().message; }',
      refused: false,
      invocation: 'frames()',
    },
    {
      name: 'unchanged factory repeated words',
      source:
        'function frames() { function make() { return new Error("ours"); } const first = (make() as Error).message; return first + (make() as Error).message; }',
      refused: false,
      invocation: 'frames()',
    },
  ])('$name', async ({ source, refused, invocation }) => {
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
