import type { Value } from '../program.ts';
import { digest } from './canonical.ts';

/**
 * The authority's own public rendering of a record — its public fields, as the declaration names
 * them — which a host that keeps rendered output beside the data can serve without running anything,
 * and which the authority keeps until the record changes. It is plain HTML of the authority's, not a
 * React or RSC payload: what a page shows of it beyond the values is the application's to compute.
 */

export interface PublicResult {
  /** The record's public fields, in the order the declaration names them. */
  readonly values: Readonly<Record<string, Value>>;
  readonly resultVersion: string;
}

export interface Materialization {
  /** Each resource read, at the version it was read at. */
  readonly dependencies: Readonly<Record<string, number>>;
  readonly result: PublicResult;
  readonly html: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeHtml(value: Value): string {
  return String(value).replaceAll(/["&'<>]/gu, (character) => ENTITIES[character] ?? character);
}

/** How long a result's version is when shown: enough to tell two apart at a glance. */
const SHOWN_VERSION_LENGTH = 12;

export function materialize(
  table: string,
  id: string,
  values: Readonly<Record<string, Value>>,
  dependencies: Readonly<Record<string, number>>,
): Materialization {
  const result: PublicResult = { resultVersion: digest(values), values };
  const name = `${escapeHtml(table)} / ${escapeHtml(id)}`;
  const html = [
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${name}</title><body>`,
    `<h1>${name}</h1>`,
    '<dl>',
    ...Object.entries(values).map(
      ([field, value]) =>
        `<dt>${escapeHtml(field)}</dt><dd><output>${escapeHtml(value)}</output></dd>`,
    ),
    '</dl>',
    `<small>Materialized by the authority / ${escapeHtml(result.resultVersion.slice(0, SHOWN_VERSION_LENGTH))}</small>`,
    '</body></html>',
  ].join('');
  return { dependencies, html, result };
}
