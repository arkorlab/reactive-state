import { describe, expect, it } from 'vitest';

import { hitsOfFile, hitsOfPath, selfCheck, textOf } from '../src/scan.ts';
import { ALLOWED, type Term, TERMS } from '../src/terms.ts';
import { FIXTURE_ALLOWED, FIXTURE_TERMS } from './fixture-terms.ts';

/** What a file says of the fixture's terms, each by its id and as the file wrote it. */
function saidIn(text: string): { readonly id: string; readonly text: string }[] {
  return hitsOfFile('file.ts', text, FIXTURE_TERMS, FIXTURE_ALLOWED).map((hit) => {
    return {
      id: hit.term.id,
      text: hit.text,
    };
  });
}

/** Where a file says the fixture's terms, each by the line and the column it starts at. */
function placesIn(text: string): { readonly line: number; readonly column: number }[] {
  return hitsOfFile('a.ts', text, FIXTURE_TERMS, FIXTURE_ALLOWED).map(({ line, column }) => {
    return {
      line,
      column,
    };
  });
}

/** The ids of what a text says of the repository's own terms. */
function termsIn(text: string): string[] {
  return hitsOfFile('a.md', text, TERMS, ALLOWED).map((hit) => hit.term.id);
}

describe('the terms', () => {
  it('each find what they say they find, and pass over what they say they pass over', () => {
    expect(selfCheck()).toStrictEqual([]);
    expect(selfCheck(FIXTURE_TERMS, FIXTURE_ALLOWED)).toStrictEqual([]);
  });

  it('are refused where one misses its own example, or takes one it should not', () => {
    const broken: Term = {
      id: 'broken',
      pattern: /example/giu,
      why: 'a term that finds the wrong words',
      finds: ['nothing here'],
      passes: ['an example'],
    };

    expect(selfCheck([broken], FIXTURE_ALLOWED)).toStrictEqual([
      'broken: does not find "nothing here"',
      'broken: finds "an example"',
    ]);
  });

  it('are refused where one is not global, which counts nothing', () => {
    const once: Term = {
      id: 'once',
      pattern: /example/iu,
      why: 'a term that cannot count',
      finds: ['an example'],
      passes: [],
    };

    expect(selfCheck([once], FIXTURE_ALLOWED)).toStrictEqual(['once: the pattern must be global']);
  });
});

describe('a file', () => {
  it('says a term where it is written, by line and column', () => {
    const [hit] = hitsOfFile(
      'src/a.ts',
      'const a = 1;\n// the sprocket gear\n',
      FIXTURE_TERMS,
      FIXTURE_ALLOWED,
    );

    expect(hit).toMatchObject({ file: 'src/a.ts', line: 2, column: 8, text: 'sprocket gear' });
  });

  it('says the line a term is on, whatever ends the lines before it', () => {
    expect(placesIn('a\rwidget')).toStrictEqual([{ line: 2, column: 1 }]);
    expect(placesIn('a\u{2028}widget')).toStrictEqual([{ line: 2, column: 1 }]);
    expect(placesIn('a\u{2029}widget')).toStrictEqual([{ line: 2, column: 1 }]);
    // CRLF is one line break, not two.
    expect(placesIn('a\r\nb\r\nwidget')).toStrictEqual([{ line: 3, column: 1 }]);
    expect(placesIn('a\nb\n  widget')).toStrictEqual([{ line: 3, column: 3 }]);
  });

  it('says its terms in the order it writes them, whatever order the terms are listed in', () => {
    expect(
      saidIn('// a gizmo\n// the widget\n// the sprocket gear').map(({ id }) => id),
    ).toStrictEqual(['gizmo', 'widget', 'sprocket-gear']);
    expect(
      saidIn('// the sprocket gear\n// the widget\n// a gizmo').map(({ id }) => id),
    ).toStrictEqual(['sprocket-gear', 'widget', 'gizmo']);
  });

  it('says a term across a wrapped comment, but not across a paragraph', () => {
    expect(saidIn('/**\n * what the sprocket\n * gear does\n */')).toStrictEqual([
      { id: 'sprocket-gear', text: 'sprocket gear' },
    ]);
    expect(saidIn('the sprocket\n\ngear')).toStrictEqual([]);
  });

  it('says a term an identifier is made of, as the identifier is written', () => {
    expect(saidIn('const isSprocketGear = true;')).toStrictEqual([
      { id: 'sprocket-gear', text: 'SprocketGear' },
    ]);
  });

  it('says nothing of what is allowed, and still reads a term outside it', () => {
    expect(saidIn('Copyright 2026 Widget Makers')).toStrictEqual([]);
    expect(saidIn('made by Widget Makers')).toStrictEqual([{ id: 'widget', text: 'Widget' }]);
    expect(saidIn("headers.set('x-widget-ok', 1);")).toStrictEqual([]);
  });

  it('reads a term where something of a name stands before or after an allowed form', () => {
    expect(saidIn("const header = 'not-x-widget-ok';")).toStrictEqual([
      { id: 'widget', text: 'widget' },
    ]);
    expect(saidIn("const header = 'x-widget-ok-extra';")).toStrictEqual([
      { id: 'widget', text: 'widget' },
    ]);
  });

  it('reads no term across an allowed form, which stands between words as itself', () => {
    expect(saidIn('sprocket x-widget-ok gear')).toStrictEqual([]);
    expect(
      hitsOfFile('a.ts', "'x-widget-ok', the gizmo", FIXTURE_TERMS, FIXTURE_ALLOWED),
    ).toMatchObject([{ line: 1, column: 20, text: 'gizmo' }]);
  });
});

describe('the allowed forms', () => {
  it('hide no name made from them, whatever joins it', () => {
    expect(termsIn("const marker = '__arkor-extra';")).toStrictEqual(['host-name']);
    expect(termsIn('mail security@arkor.ai.example')).toStrictEqual(['host-name']);
    expect(termsIn('mail security@arkor.ai+x')).toStrictEqual(['host-name']);
  });

  it('still pass where a sentence or a bracket ends after them', () => {
    expect(termsIn('Write to security@arkor.ai.')).toStrictEqual([]);
    expect(termsIn('(security@arkor.ai)')).toStrictEqual([]);
    expect(termsIn("const marker = '__arkor';")).toStrictEqual([]);
  });
});

describe("a file's path", () => {
  it('says a term it names, as the file does, at the column it starts at', () => {
    expect(hitsOfPath('packages/a/src/widget.ts', FIXTURE_TERMS, FIXTURE_ALLOWED)).toMatchObject([
      { file: 'packages/a/src/widget.ts', column: 16, text: 'widget', inPath: true },
    ]);
    expect(
      hitsOfPath('packages/a/src/sprocketGear/index.ts', FIXTURE_TERMS, FIXTURE_ALLOWED),
    ).toMatchObject([{ text: 'sprocketGear', inPath: true }]);
    expect(
      hitsOfPath('packages/a/src/delivery/policy.ts', FIXTURE_TERMS, FIXTURE_ALLOWED),
    ).toStrictEqual([]);
  });
});

describe("a file's bytes", () => {
  const encoder = new TextEncoder();

  it('are read as UTF-8 text', () => {
    expect(textOf('a.ts', encoder.encode('widget'))).toBe('widget');
  });

  it('are left unread where a NUL says the file is a binary of a binary kind', () => {
    expect(textOf('a.png', Uint8Array.of(0x89, 0x50, 0x00))).toBeUndefined();
  });

  it('are refused where a NUL says the file is not UTF-8 text, whatever its name', () => {
    expect(() => textOf('a.ts', Uint8Array.of(0x61, 0x00))).toThrow(
      'a.ts holds a NUL byte: save it as UTF-8, or name a binary by its kind',
    );
  });

  it('are refused where a byte is not UTF-8, which could split a word unseen', () => {
    // `wid` `0xff` `get`: decoded leniently, a replacement character between two halves.
    const split = Uint8Array.of(...encoder.encode('wid'), 0xff, ...encoder.encode('get'));

    expect(() => textOf('a.ts', split)).toThrow(
      'a.ts is not UTF-8: save it as UTF-8, or name a binary by its kind',
    );
    expect(textOf('a.webp', split)).toBeUndefined();
  });
});
