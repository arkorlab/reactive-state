import { type Expression, isNewExpression, type NewExpression, type Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { globalPathOf } from '../src/compiler/code-globals.ts';
import { fileReadsClock, hasFileTimestamp } from '../src/compiler/file-timestamps.ts';

/**
 * What a module writes of types alone is erased with them: a type that names the constant that
 * holds a File's options, `typeof options`, reads nothing of it, so the options are still the ones
 * written, and the File is dated. A read or a write of the constant is still one. The rows marked
 * a pin answer the same before the change as after it.
 */

const HOLDER = 'const options = { lastModified: 0 };';
const MADE = "new File([], 'x', options);";

const CASES = [
  { source: `${HOLDER} type Shown = typeof options; ${MADE}`, what: 'a type alias of its type' },
  {
    source: `${HOLDER} const copy: typeof options = { lastModified: 1 }; ${MADE}`,
    what: 'an annotation of its type',
  },
  {
    source: `${HOLDER} interface Holder { shown: typeof options } ${MADE}`,
    what: 'an interface member of its type',
  },
  {
    source: `${HOLDER} function shown(value: typeof options): void; ${MADE}`,
    what: 'a signature that takes its type',
  },
  {
    source: `${HOLDER} interface Holder { options: number } ${MADE}`,
    what: 'an interface member named as it is',
  },
  {
    source: `${HOLDER} type Holder = { options: number }; ${MADE}`,
    what: 'a type literal member named as it is',
  },
  {
    source: `${HOLDER} type Keys = keyof typeof options; ${MADE}`,
    what: 'the keys of its type',
  },
  {
    source: `${HOLDER} const typed = ${MADE.replace(';', '')} as unknown as { shown: typeof options };`,
    what: 'a cast to a type of it',
  },
] as const;

const PINS = [
  {
    dated: false,
    source: `${HOLDER} type Shown = typeof options; options.lastModified = undefined; ${MADE}`,
    what: 'a write beside a type of it (pin)',
  },
  {
    dated: false,
    source: `${HOLDER} type Shown = typeof options; change(options); ${MADE}`,
    what: 'a call handed it beside a type of it (pin)',
  },
  { dated: false, source: `${HOLDER} change(options); ${MADE}`, what: 'a call handed it (pin)' },
  { dated: true, source: `${HOLDER} ${MADE}`, what: 'no use but the File (pin)' },
] as const;

/** Whether `expression` reads the global `File`. */
function isGlobalFile(expression: Expression): boolean {
  return globalPathOf(expression)?.join('.') === 'File';
}

describe('the options of a File that a type of the constant that holds them names', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Whether the File `source` makes shows its timestamp, and whether it reads the clock. */
  function timestampOf(source: string): { readonly dated: boolean; readonly clock: boolean } {
    using parsed = api.createSourceFile('file-timestamp.ts', source);
    let made: NewExpression | undefined;
    const visit = (node: Node): void => {
      if (made === undefined && isNewExpression(node)) {
        made = node;
      }
      node.forEachChild(visit);
    };
    visit(parsed.sourceFile);
    if (made === undefined) {
      throw new Error(`No File is made in ${source}.`);
    }
    return { clock: fileReadsClock(made, isGlobalFile), dated: hasFileTimestamp(made) };
  }

  it.each(CASES)('$what', ({ source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: false, dated: true });
  });

  it.each(PINS)('$what', ({ dated, source }) => {
    expect(timestampOf(source)).toStrictEqual({ clock: !dated, dated });
  });
});
