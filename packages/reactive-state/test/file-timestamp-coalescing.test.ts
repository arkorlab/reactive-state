import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * A `lastModified` of `left ?? right` is `right` where `left` is `null` as much as where it is
 * `undefined`, and a File given `undefined` takes its timestamp of the clock: `left` shows the
 * timestamp only where it is never `null` either — `null` alone is a timestamp, `0`, which a
 * File's options read as a number. The rows marked a pin are taken before the change as after it.
 */

const CASES = [
  { dated: false, options: '{ lastModified: null ?? undefined }', what: 'null before undefined' },
  {
    dated: false,
    options: '{ lastModified: (flag ? null : 0) ?? stamp }',
    what: 'a branch of null before a read',
  },
  {
    dated: false,
    options: '{ lastModified: (stamp ?? null) ?? undefined }',
    what: 'null of a fallback before undefined',
  },
  {
    dated: false,
    options: '{ lastModified: nothing ?? stamp }',
    what: 'a held null before a read',
  },
  { dated: true, options: '{ lastModified: null }', what: 'null alone (pin)' },
  { dated: true, options: '{ lastModified: null ?? 0 }', what: 'null before a number (pin)' },
  { dated: true, options: '{ lastModified: stamp ?? null }', what: 'a read before null (pin)' },
  { dated: true, options: '{ lastModified: 0 ?? stamp }', what: 'a number before a read (pin)' },
  {
    dated: true,
    options: '{ lastModified: fixed ?? stamp }',
    what: 'a held number before a read (pin)',
  },
  {
    dated: true,
    options: '{ lastModified: (flag ? 1 : 2) ?? stamp }',
    what: 'numbers of each branch before a read (pin)',
  },
  { dated: true, options: '{ lastModified: stamp || null }', what: 'a read or null (pin)' },
] as const;

/** The source of a module that makes a File of `options`, beside the names they read. */
function moduleOf(options: string): string {
  return [
    'declare const flag: boolean;',
    'declare const stamp: number | undefined;',
    'const nothing = null;',
    'const fixed = 5;',
    `new File([], 'x', ${options});`,
  ].join('\n');
}

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('a File timestamp of ?? whose left may be null', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File made of `options` shows its timestamp, and whether it reads the clock. */
  function timestampOf(options: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', moduleOf(options));
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error(`No File is made of ${options}.`);
    }
    return { clock: fileReadsClock(made, isGlobalFile), dated: hasFileTimestamp(made) };
  }

  it.each(CASES)('$what', ({ dated, options }) => {
    expect(timestampOf(options)).toStrictEqual({ clock: !dated, dated });
  });
});
