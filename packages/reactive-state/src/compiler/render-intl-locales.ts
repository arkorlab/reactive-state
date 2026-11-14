import { type Expression, isArrayLiteralExpression, isSpreadElement } from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/** Written locale requests avoid a default only when native negotiation has a supported match. */

export const ADDITIONAL_INTL_FORMATTERS: ReadonlySet<string> = new Set([
  'Intl.DisplayNames',
  'Intl.Segmenter',
]);

type Matcher = 'lookup' | 'best fit';
type Support = (locales: string[], matcher: Matcher) => readonly string[];

const SUPPORT = new Map<string, Support>([
  [
    'Intl.Collator',
    (locales, matcher) => Intl.Collator.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.DateTimeFormat',
    (locales, matcher) =>
      Intl.DateTimeFormat.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.DisplayNames',
    (locales, matcher) => Intl.DisplayNames.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  ['Intl.DurationFormat', durationLocales],
  [
    'Intl.ListFormat',
    (locales, matcher) => Intl.ListFormat.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.NumberFormat',
    (locales, matcher) => Intl.NumberFormat.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.PluralRules',
    (locales, matcher) => Intl.PluralRules.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.RelativeTimeFormat',
    (locales, matcher) =>
      Intl.RelativeTimeFormat.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
  [
    'Intl.Segmenter',
    (locales, matcher) => Intl.Segmenter.supportedLocalesOf(locales, { localeMatcher: matcher }),
  ],
]);
const MATCHERS: readonly Matcher[] = ['lookup', 'best fit'];

/** Runtime DurationFormat support is proved without extending the package's language library. */
function durationLocales(locales: string[], matcher: Matcher): readonly string[] {
  try {
    const constructor: unknown = Reflect.get(Intl, 'DurationFormat');
    if (typeof constructor !== 'function') return [];
    const support: unknown = Reflect.get(constructor, 'supportedLocalesOf');
    if (typeof support !== 'function') return [];
    const result: unknown = Reflect.apply(support, constructor, [
      locales,
      { localeMatcher: matcher },
    ]);
    return Array.isArray(result) && result.every((entry: unknown) => typeof entry === 'string')
      ? result
      : [];
  } catch {
    return [];
  }
}

/** Supported native requests and guaranteed invalid requests do not fall back to the default locale. */
export function fixedIntlLocale(
  node: Expression | undefined,
  kind: string,
  text: (node: Expression) => string | undefined,
): boolean {
  const locales = writtenLocales(node, text);
  const support = SUPPORT.get(kind);
  if (support === undefined || locales === undefined || locales.length === 0) return false;
  try {
    return MATCHERS.every((matcher) => support(locales, matcher).length > 0);
  } catch (error) {
    return (
      error instanceof RangeError &&
      (ADDITIONAL_INTL_FORMATTERS.has(kind) || locales.every((locale) => locale.length > 0))
    );
  }
}

/** Only written whole primitive strings and a finite literal list retain their source request. */
function writtenLocales(
  node: Expression | undefined,
  text: (node: Expression) => string | undefined,
): string[] | undefined {
  if (node === undefined) return undefined;
  const value = unwrapped(node);
  const values = isArrayLiteralExpression(value) ? value.elements : [value];
  const locales: string[] = [];
  for (const each of values) {
    if (isSpreadElement(each)) return undefined;
    const locale = text(each);
    if (locale === undefined) return undefined;
    locales.push(locale);
  }
  return locales;
}
