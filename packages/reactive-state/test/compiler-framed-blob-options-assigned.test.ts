import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * The `type` option of a `Blob` or a `File` is converted to text. Where the options are the result of
 * an assign with a source no reader follows (a spread of a parameter), what the field holds is what
 * the type the result is written as says: a result asserted to hold an Error there may. A module
 * that constructs a `Blob` or a `File` is refused whatever it does with it, so the rows are read at
 * the reader only.
 */
const CASES = [
  {
    id: 'blob-type-assert-spread-result',
    source:
      'function frames(...sources:{type:Error}[]){return new Blob([],Object.assign({},...sources)as{type:Error}as never).type;}',
    refused: true,
  },
  {
    id: 'file-type-assert-spread-result',
    source:
      "function frames(...sources:{type:Error}[]){return new File([],'name',Object.assign({},...sources)as{type:Error}as never).type;}",
    refused: true,
  },
  {
    id: 'blob-type-object-spread-of-assert-spread-result',
    source:
      'function frames(...sources:{type:Error}[]){return new Blob([],{...(Object.assign({},...sources)as{type:Error})}as never).type;}',
    refused: true,
  },
  {
    id: 'blob-type-assert-spread-result-past-written-list',
    source:
      'function frames(...sources:{type:Error}[]){const defaults=[{other:1}];note();return new Blob([],Object.assign({},...defaults,...sources)as{type:Error}as never).type;}function note(){return 0;}',
    refused: true,
  },
  {
    id: 'blob-type-assert-spread-result-held',
    source:
      'function frames(...sources:{type:Error}[]){const options=Object.assign({},...sources)as{type:Error};return new Blob([],options as never).type;}',
    refused: true,
  },
  {
    id: 'blob-type-single-source-assert',
    source:
      'function frames(source:{type:Error}){return new Blob([],Object.assign({},source)as{type:Error}as never).type;}',
    refused: true,
  },
  {
    id: 'blob-type-spread-result-unasserted-data',
    source:
      'function frames(error:Error,...sources:object[]){void error;return new Blob([],Object.assign({},...sources)).type;}',
    refused: false,
  },
  {
    id: 'blob-type-assert-spread-result-data-type',
    source:
      'function frames(error:Error,...sources:{type:string}[]){void error;return new Blob([],Object.assign({},...sources)as{type:string}).type;}',
    refused: false,
  },
  {
    id: 'blob-type-assert-written-result-data-pin',
    source:
      "function frames(error:Error){void error;return new Blob([],Object.assign({},{type:'text/plain'})as{type:Error}as never).type;}",
    refused: false,
  },
] as const;

describe('options of a Blob and a File that are the result of an assign with a spread', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'blob-options-assigned.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});
