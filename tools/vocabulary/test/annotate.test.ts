import { describe, expect, it } from 'vitest';

import { annotationOf } from '../src/annotate.ts';
import { hitsOfFile, hitsOfPath } from '../src/scan.ts';
import { FIXTURE_ALLOWED, FIXTURE_TERMS } from './fixture-terms.ts';

describe('an annotation', () => {
  it('names the file, the line, the column and the term', () => {
    const [hit] = hitsOfFile('packages/a/a.ts', '// the widget', FIXTURE_TERMS, FIXTURE_ALLOWED);

    expect(hit && annotationOf(hit)).toBe(
      `::error file=packages/a/a.ts,line=1,col=8,title=vocabulary/widget::"widget": a word the fixture refuses`,
    );
  });

  it('names the file alone where its path says the term', () => {
    const [hit] = hitsOfPath('packages/a/widget.ts', FIXTURE_TERMS, FIXTURE_ALLOWED);

    expect(hit && annotationOf(hit)).toBe(
      `::error file=packages/a/widget.ts,title=vocabulary/widget::"widget" (in the path): a word the fixture refuses`,
    );
  });

  it("escapes what in a file's name would end a property or the command", () => {
    const [hit] = hitsOfFile('a,b:c\nd%.ts', '// the widget', FIXTURE_TERMS, FIXTURE_ALLOWED);

    expect(hit && annotationOf(hit)).toMatch(/^::error file=a%2Cb%3Ac%0Ad%25\.ts,line=1,/u);
  });
});
