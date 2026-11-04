import type { Hit } from './scan.ts';

/**
 * A value as a workflow command carries it (`escapeData` in `@actions/core`): the `%` and the line
 * breaks that would end the command and begin another, escaped.
 */
function commandData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * A property of a workflow command (`escapeProperty`): what `commandData` escapes, and the `:` and
 * `,` that would end the property — any of which a file's name may hold.
 */
function commandProperty(value: string): string {
  return commandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * A mention as GitHub annotates it: an `::error` workflow command on the line that makes it, or on
 * the file whose path makes it.
 */
export function annotationOf(hit: Hit): string {
  const title = `vocabulary/${hit.term.id}`;
  const said = hit.inPath === true ? ' (in the path)' : '';
  const message = `${JSON.stringify(hit.text)}${said}: ${hit.term.why}`;
  const properties = [
    `file=${commandProperty(hit.file)}`,
    ...(hit.inPath === true ? [] : [`line=${String(hit.line)}`, `col=${String(hit.column)}`]),
    `title=${commandProperty(title)}`,
  ].join(',');
  return `::error ${properties}::${commandData(message)}`;
}

/** Exceptions are one escaped annotation, even when a repository filename contains newlines. */
export function errorAnnotation(message: string): string {
  return `::error title=vocabulary::${commandData(message)}`;
}

/**
 * What JSON's string encoding leaves as it is but a terminal or a reader of lines takes as more than
 * text: DEL, the C1 controls (`U+009B` begins an escape sequence on its own), and the Unicode line
 * and paragraph separators.
 */
const UNSAFE_AFTER_JSON = /[\u{7F}-\u{9F}\u{2028}\u{2029}]/gu;
const HEX = 16;
const ESCAPE_DIGITS = 4;

/**
 * A plain diagnostic kept to one line of text: JSON's string encoding of it, which escapes the C0
 * controls, and the escapes of what it leaves (`UNSAFE_AFTER_JSON`).
 */
export function plainDiagnostic(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replaceAll(UNSAFE_AFTER_JSON, (character) => {
      const code = (character.codePointAt(0) ?? 0).toString(HEX).padStart(ESCAPE_DIGITS, '0');
      return String.raw`\u${code}`;
    });
}
