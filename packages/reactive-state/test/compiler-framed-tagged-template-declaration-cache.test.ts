import { isFunctionDeclaration, isTaggedTemplateExpression, type Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isErased } from '../src/compiler/code-globals.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A source-written tag that is a function declaration is proven unchanged once per declaration, from
 * one index of the writes of the file, however many error-bearing templates use it.
 */

const SCALE = {
  count: 60,
  maxBallastWalks: 8,
} as const;

const TAG = "function tag(_s: TemplateStringsArray, _v: unknown) { return 'safe'; }";
const BALLAST = 'function ballast() { return [1, 2, 3]; }';

function sharedTagSource(count: number): string {
  const handlers: string[] = [];
  for (let index = 0; index < count; index++) {
    handlers.push(`function h${index}(error: Error) { return tag\`failed \${error}\`; }`);
  }
  return `${TAG} ${handlers.join(' ')} ${BALLAST}`;
}

function distinctTagsSource(count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    parts.push(
      `function tag${index}(_s: TemplateStringsArray, _v: unknown) { return 'safe'; } function h${index}(error: Error) { return tag${index}\`failed \${error}\`; }`,
    );
  }
  return `${parts.join(' ')} ${BALLAST}`;
}

const SCALING_CASES = [
  {
    id: 'sixty-templates-sharing-one-declared-tag',
    source: sharedTagSource(SCALE.count),
  },
  {
    id: 'sixty-templates-each-with-its-own-declared-tag',
    source: distinctTagsSource(SCALE.count),
  },
] as const;

const SEMANTIC_CASES = [
  {
    framed: false,
    id: 'unchanged-declared-tag-ignoring-its-substitution-taken',
    source: `${TAG} function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: false,
    id: 'overload-signatures-with-one-body-taken',
    source: `function tag(_s: TemplateStringsArray, _v: unknown): string; function tag(_s: TemplateStringsArray, _v: unknown) { return 'safe'; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: false,
    id: 'shadowing-sibling-reassignment-keeps-the-tag-unchanged',
    source: `${TAG} function other() { let tag = 0; tag = 1; return tag; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'reassigned-declared-tag-refused',
    source: `${TAG} function swap(other: (s: TemplateStringsArray, v: unknown) => string) { tag = other; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'destructured-reassignment-of-declared-tag-refused',
    source: `${TAG} function swap(other: (s: TemplateStringsArray, v: unknown) => string) { [tag] = [other]; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'object-pattern-reassignment-of-declared-tag-refused',
    source: `${TAG} function swap(other: (s: TemplateStringsArray, v: unknown) => string) { ({ tag } = { tag: other }); } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'loop-assignment-of-declared-tag-refused',
    source: `${TAG} function swap(others: ((s: TemplateStringsArray, v: unknown) => string)[]) { for (tag of others) { void tag; } } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'asserted-reassignment-of-declared-tag-refused',
    source: `${TAG} function swap(other: (s: TemplateStringsArray, v: unknown) => string) { (tag as unknown) = other; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'duplicate-bodies-of-declared-tag-refused',
    source: `${TAG} function tag(_s: TemplateStringsArray, v: unknown) { return String(v); } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'reassigned-overload-family-refused',
    source: `function tag(_s: TemplateStringsArray, _v: unknown): string; function tag(_s: TemplateStringsArray, _v: unknown) { return 'safe'; } function swap(other: (s: TemplateStringsArray, v: unknown) => string) { tag = other; } function text(error: Error) { return tag\`failed \${error}\`; }`,
  },
  {
    framed: true,
    id: 'declared-tag-reading-its-substitution-still-refused-among-cached-uses',
    source: `function tag(_s: TemplateStringsArray, v: unknown) { return String(v); } function a(error: Error) { return tag\`a \${error}\`; } function b(error: Error) { return tag\`b \${error}\`; }`,
  },
] as const;

describe('cached declaration immutability for source-written template tags', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(SCALING_CASES)('$id', ({ source }) => {
    const result = measureTemplateWalks(api, source);

    expect(result.framedCount).toBe(0);
    expect(result.templateCount).toBe(SCALE.count);
    expect(result.ballastWalks).toBeLessThanOrEqual(SCALE.maxBallastWalks);
  });

  it.each(SEMANTIC_CASES)('$id', ({ framed, source }) => {
    expect(readsFrames(api, source)).toBe(framed);
  });
});

function measureTemplateWalks(
  api: API,
  source: string,
): {
  readonly ballastWalks: number;
  readonly framedCount: number;
  readonly templateCount: number;
} {
  using parsed = parseModule(api, 'tagged-template-declaration-cache.ts', source);
  const templates: Node[] = [];
  let ballast: Node = parsed.sourceFile;
  const collect: Node[] = [parsed.sourceFile];
  for (let node = collect.pop(); node !== undefined; node = collect.pop()) {
    if (isFunctionDeclaration(node) && node.name?.text === 'ballast' && node.body !== undefined) {
      ballast = node.body;
    }
    if (isTaggedTemplateExpression(node)) templates.push(node);
    node.forEachChild((child) => {
      collect.push(child);
    });
  }
  const spy = vi.spyOn(ballast, 'forEachChild');
  let framedCount = 0;
  for (const template of templates) {
    if (framedRead(template) !== undefined) framedCount += 1;
  }
  const ballastWalks = spy.mock.calls.length;
  spy.mockRestore();
  return { ballastWalks, framedCount, templateCount: templates.length };
}

function readsFrames(api: API, source: string): boolean {
  using parsed = parseModule(api, 'tagged-template-declaration-semantics.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isErased(node)) continue;
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
