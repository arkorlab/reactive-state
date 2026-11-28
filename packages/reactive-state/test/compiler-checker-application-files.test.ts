import { describe, expect, it } from 'vitest';

import { framedApplicationFile } from '../src/compiler/type-checker.ts';

/**
 * The files a checker's program reads that the compile tracks as its own reads: a rooted path,
 * POSIX or a Windows drive's as TypeScript writes it, outside `node_modules`; no bundled library.
 */
const CASES = [
  { file: '/project/src/domain/item.ts', own: true },
  { file: 'C:/project/src/domain/item.ts', own: true },
  { file: 'd:/work/app/shared/types.d.ts', own: true },
  { file: '/project/node_modules/react/index.d.ts', own: false },
  { file: 'C:/project/node_modules/@types/node/index.d.ts', own: false },
  { file: 'bundled:///libs/lib.es2024.d.ts', own: false },
  { file: 'src/relative.ts', own: false },
];

describe('checker application files', () => {
  it.each(CASES)('$file', ({ file, own }) => {
    expect(framedApplicationFile(file)).toBe(own);
  });
});
