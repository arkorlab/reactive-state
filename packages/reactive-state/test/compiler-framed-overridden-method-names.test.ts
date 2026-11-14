import { describe, expect, it } from 'vitest';

import { mutatorInvocation } from '../src/compiler/framed-mutator-calls.ts';
import { methodMayBeOverridden } from '../src/compiler/framed-overridden-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Whether a file may give an array a method of its own, by a name it computes of constants it writes
 * out: a text joined of texts, a template with constants, a constant that holds one. The name is the
 * text it makes, as it is when it is written in one piece; a name built by a call, or of what the code
 * does not tell, is one that may be any: the compile does not evaluate a joined text, so it is refused
 * whatever the text, and a rule that learns to evaluate one must still count the name it makes.
 */
const HEAD =
  'function frames(name: string) { const values: unknown[] = []; const other: unknown[] = []; ';

const CASES = [
  {
    id: 'define-by-a-concatenated-name',
    source: `${HEAD} Object.defineProperty(values, 'so' + 'rt', { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-concatenated-name-through-a-constant',
    source: `${HEAD} const key = 'so' + 'rt'; Object.defineProperty(values, key, { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-name-concatenated-from-constants',
    source: `${HEAD} const head = 'so'; const key = head + 'rt'; Object.defineProperty(values, key, { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-three-part-name',
    source: `${HEAD} Object.defineProperty(values, 's' + 'o' + 'rt', { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-nested-concatenation',
    source: `${HEAD} Object.defineProperty(values, 's' + ('o' + 'rt'), { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-template-with-a-constant',
    source: `${HEAD} Object.defineProperty(values, \`so\${'rt'}\`, { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-concatenated-name-through-reflect',
    source: `${HEAD} Reflect.defineProperty(values, 'so' + 'rt', { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-properties-by-a-concatenated-name',
    source: `${HEAD} Object.defineProperties(values, { ['so' + 'rt']: { value: () => other } }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'assign-by-a-computed-field-with-a-concatenation',
    source: `${HEAD} Object.assign(values, { ['so' + 'rt']: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'assignment-by-a-concatenated-element-access',
    source: `${HEAD} (values as any)['so' + 'rt'] = () => other; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'assignment-by-a-name-concatenated-from-constants',
    source: `${HEAD} const head = 'so'; (values as any)[head + 'rt'] = () => other; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'compound-assignment-by-a-concatenated-name',
    source: `${HEAD} (values as any)['so' + 'rt'] ||= () => other; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'deletion-by-a-concatenated-name',
    source: `${HEAD} delete (values as any)['so' + 'rt']; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'assignment-by-a-name-concatenated-with-a-parameter',
    source: `${HEAD} (values as any)[name + 'rt'] = () => other; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-name-built-by-a-call',
    source: `${HEAD} Object.defineProperty(values, 'so'.concat('rt'), { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-concatenation-of-another-name-may-be-any',
    source: `${HEAD} Object.defineProperty(values, 'fi' + 'll', { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'define-by-a-concatenation-that-is-not-the-name-may-be-any',
    source: `${HEAD} Object.defineProperty(values, 'so' + 'rted', { value: () => other }); return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'assignment-by-another-concatenated-name-may-be-any',
    source: `${HEAD} (values as any)['le' + 'ngth'] = 0; return values.sort(); }`,
    overridden: true,
  },
  {
    id: 'no-write-pin',
    source: `${HEAD} void values; return values.sort(); }`,
    overridden: false,
  },
] as const;

describe('a method an array may be given by a name the file computes', () => {
  it.each(CASES)('$id', ({ source, overridden }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'concatenated-names.ts', source);

    expect(methodMayBeOverridden(parsed.sourceFile, 'sort', mutatorInvocation)).toBe(overridden);
  });
});
