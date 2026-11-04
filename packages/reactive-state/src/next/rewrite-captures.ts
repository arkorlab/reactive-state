/**
 * What a rewrite's destination may be made of by what its rule captured, as a build's routing
 * writes one for its adapter (`onBuildComplete`): each `$1` or `$name` it writes is filled in with a
 * value the request brought, and the path the router sets on the URL then resolves the dot segments
 * it holds. What a reference may hold is read off the rule's own pattern (`sourceRegex`), as upwind
 * core reads a rewrite onto a gated route (`rewrite-captures.ts`):
 *
 * - `segment`: one whole segment of the request's path (`:slug`), never empty — a pattern of the
 *   application's own (`:id(\d+)`) as well, of one segment, where it is `bounded` and holds a
 *   character at least;
 * - `segments`: whole segments of it (`:path*`, `:path+`), none perhaps;
 * - `bounded`: what a pattern of the application's own lets hold no `/`, `.`, `%` or `\` — one class
 *   of letters, digits, `_` or `-`, repeated or not — none perhaps;
 * - `part`: part of one segment (`:name.png`), which may be `.` or `..` and climb a level;
 * - `any`: anything else — a value a `has` condition captured from the query, a header or a cookie,
 *   any other pattern of the application's own, a name the rule captures nothing under — which may
 *   hold `/` and `..`, and so make the path any path at all.
 *
 * The request's path is the URL's, its dot segments resolved before the router matches a rule
 * against it: a whole segment of it is never `.` or `..`.
 */

type CaptureKind = 'any' | 'bounded' | 'part' | 'segment' | 'segments';

/** A reference a destination's path makes to a capture: where it is, and what it may hold. */
export interface Reference {
  readonly at: number;
  readonly kind: CaptureKind;
}

/** A capturing group of a pattern: its name, if any, what it matches, and what stands around it. */
interface CaptureGroup {
  readonly name: string | undefined;
  readonly content: string;
  readonly before: string;
  readonly after: string;
}

/** A group as it was opened: whether it captures, under what name, and where its content starts. */
interface OpenGroup {
  readonly capturing: boolean;
  readonly name: string | undefined;
  readonly open: number;
  readonly contentStart: number;
}

/** Where a scan of a pattern is: the groups open, those closed, and whether it is in a class. */
interface Scan {
  readonly pattern: string;
  readonly opened: OpenGroup[];
  readonly closed: { readonly order: number; readonly group: CaptureGroup }[];
  readonly orderOf: Map<OpenGroup, number>;
  inClass: boolean;
}

/** A pattern as Next.js may write it: its slashes as they are, or escaped. */
function spellings(pattern: string): readonly string[] {
  return [pattern, pattern.replaceAll('/', String.raw`\/`)];
}

/** What Next.js compiles a param of one whole segment to (`:slug`). */
const SEGMENT_PATTERNS: ReadonlySet<string> = new Set(
  ['[^/]+', '[^/]+?'].flatMap((pattern) => spellings(pattern)),
);
/** And a param of whole segments (`:path+`, `:path*`). */
const SEGMENTS_PATTERNS: ReadonlySet<string> = new Set(spellings('(?:[^/]+?)(?:/(?:[^/]+?))*'));
/** A group that captures under a name: `(?<name>…`. */
const NAMED_OPENING = /^\(\?<(?<name>[$A-Z_a-z][\w$]*)>/u;
/** A segment's own end in a pattern: the path's, a slash, or the next segment's group. */
const SEGMENT_END = /^(?:$|\$|\\\/|\/|\(\?:\\\/|\(\?:\/)/u;
/** What closes the wrapping groups a param is written in, and makes them optional. */
const WRAPPER_CLOSE = /^[)?]+/u;
/** A repeat of one class, lazily or not: `+`, `*`, `?`, `{2}`, `{2,}`, `{2,8}`. */
const REPEAT = /(?:[*+?]|\{\d+(?:,\d*)?\})\??$/u;
/** One class of characters: an escape of digits or of word characters, or a bracket's, not negated. */
const ONE_CLASS = /^(?:\\[dw]|\[(?!\^)[^\]]*\])$/u;
/** What makes a path of another shape held in a segment: a slash, a dot, an escape, a backslash. */
const SHAPING: readonly string[] = ['/', '.', '%', '\\'];
/** A reference a destination makes to a capture: `$1`, `$slug`. */
const REFERENCE = /\$(?<reference>\w+)/gu;
const PLACE = /^\d+$/u;

/** The group a `(` at `at` opens. */
function openGroup(pattern: string, at: number): OpenGroup {
  if (pattern[at + 1] !== '?') {
    return { capturing: true, contentStart: at + 1, name: undefined, open: at };
  }
  const named = NAMED_OPENING.exec(pattern.slice(at));
  return named === null
    ? { capturing: false, contentStart: at, name: undefined, open: at }
    : {
        capturing: true,
        contentStart: at + named[0].length,
        name: named.groups?.['name'],
        open: at,
      };
}

/** The group a `)` at `at` closes, kept where it captures. */
function closeGroup(scan: Scan, at: number): void {
  const group = scan.opened.pop();
  const order = group === undefined ? undefined : scan.orderOf.get(group);
  if (group === undefined || order === undefined) {
    return;
  }
  const { pattern } = scan;
  const content = pattern.slice(group.contentStart, at);
  const around = { after: pattern.slice(at + 1), before: pattern.slice(0, group.open) };
  scan.closed.push({ group: { content, name: group.name, ...around }, order });
}

/** What the character at `at` does to the scan; the last character it read. */
function step(scan: Scan, at: number): number {
  const character = scan.pattern.charAt(at);
  if (character === '\\') {
    return at + 1;
  }
  if (scan.inClass) {
    scan.inClass = character !== ']';
    return at;
  }
  switch (character) {
    case '[': {
      scan.inClass = true;
      break;
    }
    case '(': {
      const group = openGroup(scan.pattern, at);
      if (group.capturing) {
        scan.orderOf.set(group, scan.orderOf.size);
      }
      scan.opened.push(group);
      break;
    }
    case ')': {
      closeGroup(scan, at);
      break;
    }
    default: {
      break;
    }
  }
  return at;
}

/** The capturing groups of a pattern, in the order their references count them (`$1`, `$2`). */
function captureGroupsOf(pattern: string): CaptureGroup[] {
  const scan: Scan = { closed: [], inClass: false, opened: [], orderOf: new Map(), pattern };
  let at = 0;
  while (at < pattern.length) {
    at = step(scan, at) + 1;
  }
  return scan.closed.toSorted((one, other) => one.order - other.order).map(({ group }) => group);
}

/** Whether a group takes a segment from its start to its end, as Next.js writes a whole param. */
function wholeSegments(group: CaptureGroup): boolean {
  const starts = group.before.endsWith('/');
  return starts && SEGMENT_END.test(group.after.replace(WRAPPER_CLOSE, ''));
}

/**
 * `content`, a pattern of the application's own, as a pattern of its own, where it matches nothing
 * that holds a character that shapes a path (`SHAPING`): one class, repeated or not, that takes
 * none of them; none for any other.
 */
function boundedPattern(content: string): RegExp | undefined {
  const single = content.replace(REPEAT, '');
  if (!ONE_CLASS.test(single)) {
    return undefined;
  }
  try {
    /* eslint-disable security/detect-non-literal-regexp -- the build's own routing's patterns. */
    const one = new RegExp(`^${single}$`, 'u');
    const whole = new RegExp(`^(?:${content})$`, 'u');
    /* eslint-enable security/detect-non-literal-regexp */
    return SHAPING.some((character) => one.test(character)) ? undefined : whole;
  } catch {
    return undefined;
  }
}

/** What a capturing group may hold (above). */
function kindOfGroup(group: CaptureGroup): CaptureKind {
  if (SEGMENT_PATTERNS.has(group.content)) {
    return wholeSegments(group) ? 'segment' : 'part';
  }
  if (SEGMENTS_PATTERNS.has(group.content) && wholeSegments(group)) {
    return 'segments';
  }
  const bounded = boundedPattern(group.content);
  if (bounded === undefined) {
    return 'any';
  }
  return wholeSegments(group) && !bounded.test('') ? 'segment' : 'bounded';
}

/** What `reference` — a place (`1`) or a name — may hold of `groups`: `any` where it names none. */
function kindOfReference(reference: string, groups: readonly CaptureGroup[]): CaptureKind {
  const group = PLACE.test(reference)
    ? groups[Number(reference) - 1]
    : groups.find((each) => each.name === reference);
  return group === undefined ? 'any' : kindOfGroup(group);
}

/** The reference `match` found, and what it may hold of `groups`. */
function referenceOf(match: RegExpExecArray, groups: readonly CaptureGroup[]): Reference {
  return { at: match.index, kind: kindOfReference(match.groups?.['reference'] ?? '', groups) };
}

/**
 * Each reference `path` — what a destination sets as the URL's path — makes to what the rule of
 * `sourceRegex` captured, in order: where it is, and what it may hold.
 */
export function referencesOf(path: string, sourceRegex: string): Reference[] {
  const groups = captureGroupsOf(sourceRegex);
  return [...path.matchAll(REFERENCE)].map((match) => referenceOf(match, groups));
}
