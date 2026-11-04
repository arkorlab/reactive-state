/**
 * What `pnpm check:vocabulary` looks for, and what it lets through: a list of its own, so that a
 * change to it is read as one. A term says why it is out, and carries the words it must find and the
 * words it must pass over, which the check tries before it reads anything (`selfCheck`).
 */

export interface Term {
  readonly id: string;
  /**
   * Global, so every occurrence in a file is counted. Words are apart by ` +`, by `_` and a space in
   * an identifier, or by `-`, and a term ends where no letter or digit follows, an identifier's `_`
   * among what may — after its plural, where the plural names the same thing: a file is searched as
   * `searchable` reads it.
   */
  readonly pattern: RegExp;
  readonly why: string;
  /** What the pattern must find, and what it must not: tried before anything is read. */
  readonly finds: readonly string[];
  readonly passes: readonly string[];
}

export const TERMS: readonly Term[] = [
  {
    id: 'host-name',
    pattern: /\barkor(?![\da-z])/giu,
    why: 'a host by name: the framework runs on whichever host serves it, and keeps only the identifiers it shares with the edge it runs behind',
    finds: [
      'Arkor',
      'www.arkor.example',
      'an arkor.example hostname',
      'not-x-arkor-edge',
      'x-arkor-other',
      'MY_ARKOR_KEY',
      'arkor:module',
      'my__arkor',
      '__arkor-extra',
      'security@arkor.ai.example',
      'security@arkor.ai+x',
    ],
    passes: [
      'x-arkor-edge',
      '.arkor/bundle.json',
      "'.arkor'",
      '__arkor',
      'darkorange',
      '@arkorlab/reactive-state',
      'security@arkor.ai',
      'write to security@arkor.ai.',
      '(security@arkor.ai)',
      'Copyright 2026 Arkor and Contributors',
    ],
  },
  {
    id: 'control-plane',
    pattern: /\bcontrol(?:-|_? +)planes?(?![\da-z])/giu,
    why: 'whatever publishes a deployment is the host, and this repository does not name its parts',
    finds: [
      'the control plane',
      'control-plane',
      'the control\nplane',
      'the control\n * plane',
      'controlPlane',
      'isControlPlaneRequest',
      'control_plane',
      'CONTROL_PLANE',
      'control planes',
      'controlPlanes',
    ],
    passes: ['controls the plane', 'control\n\nplane', 'control planet'],
  },
  {
    id: 'dispatch-namespace',
    pattern: /\bdispatch(?:-|_? +)namespaces?(?![\da-z])/giu,
    why: 'an application reaches what it runs on through the bindings it is given, whatever a host runs it in',
    finds: [
      'dispatch namespace',
      'dispatch namespaces',
      'dispatch\n  // namespace',
      'dispatchNamespace',
      'DISPATCH_NAMESPACE',
    ],
    passes: ['dispatch to a namespace'],
  },
  {
    id: 'workers-for-platforms',
    pattern: /\bworkers(?:-|_? +)for(?:-|_? +)platforms(?![\da-z])/giu,
    why: 'an application reaches what it runs on through the bindings it is given, whatever a host runs it in',
    finds: [
      'Workers for Platforms',
      'Workers for\r\nPlatforms',
      'workersForPlatforms',
      'WORKERS_FOR_PLATFORMS',
      'workers-for-platforms',
    ],
    passes: ['workers for a platform'],
  },
  {
    id: 'validation-namespace',
    pattern: /\bvalidation(?:-|_? +)namespaces?(?![\da-z])/giu,
    why: "how a host proves a deployment before it goes live is the host's own",
    finds: [
      'the validation namespace',
      'the validation\n# namespace',
      'validationNamespaces',
      'validation-namespace',
    ],
    passes: ['validation of a namespace'],
  },
  {
    id: 'analytics-engine',
    pattern: /\banalytics(?:-|_? +)engines?(?![\da-z])/giu,
    why: "where a host records what it measures is the host's own",
    finds: [
      'Analytics Engine',
      'Analytics\n> Engine',
      'analyticsEngine',
      'ANALYTICS_ENGINE',
      'analytics-engine',
      'analytics engines',
    ],
    passes: ['analytics, an engine', 'analytics engineer'],
  },
  {
    id: 'billing',
    pattern: /billing/giu,
    why: 'what a host charges for',
    finds: ['billing', 'billingEvent', 'BILLING_KEY'],
    passes: ['billion'],
  },
  {
    id: 'readme-reference',
    pattern: /\(README, +"/gu,
    why: "a section of another repository's README: cite this repository's documents by their path",
    finds: ['(README, "Caching")', '(README,\n * "Caching")'],
    passes: ['(the README)'],
  },
  {
    id: 'this-platform',
    pattern: /\bthis(?:-|_? +)platform(?![\da-z])/giu,
    why: 'a host spoken of as if it were the only one: name what it is, or say "the host"',
    finds: [
      'this platform',
      'this\nplatform',
      'this\n   * platform',
      'thisPlatform',
      'this-platform',
    ],
    passes: ['the platform', 'a platform', 'this\n\nplatform', 'these platforms'],
  },
  {
    id: 'specification-version',
    pattern: /\bspec\/v\d/gu,
    why: 'a version of a specification this repository does not hold: say what is meant here',
    finds: ['spec/v4', '(spec/v2/README.md)', "'spec/v6/MEASUREMENT.md'"],
    passes: ['spec/', 'inspect/v2', 'spec/vendor'],
  },
];

/**
 * What is said under the name of the company that publishes this repository and is no mention of a
 * host, blanked out of a file before it is searched, column for column: the header the edge this
 * framework runs behind publishes (`x-arkor-edge`), that edge's build directory (`.arkor`) and its
 * marker (`__arkor`), the organization's own name (`arkorlab`), the security contact, and the
 * copyright holder. Each is blanked only where nothing of a name — a letter or a digit of any script,
 * `_` or `-` — stands on either side of it, so another name made from it is still searched as any
 * name is. The security contact is an address, so a `.` or a `+` before it, a `+` after it, or a `.`
 * that a letter or a digit follows (a longer domain) makes it another address, searched as well; a
 * sentence's full stop after it does not. An addition here is reviewed as a change of its own.
 */
export const ALLOWED: readonly RegExp[] = [
  /(?<![\p{L}\p{N}_-])x-arkor-edge(?![\p{L}\p{N}_-])/giu,
  /(?<![\p{L}\p{N}_-])\.arkor(?![\p{L}\p{N}_-])/gu,
  /(?<![\p{L}\p{N}_-])__arkor(?![\p{L}\p{N}_-])/gu,
  /(?<![\p{L}\p{N}_-])arkorlab(?![\p{L}\p{N}_-])/gu,
  /(?<![\p{L}\p{N}_.+-])security@arkor\.ai(?![\p{L}\p{N}_+-]|\.[\p{L}\p{N}])/gu,
  /\bCopyright (?:\(c\) )?\d{4} Arkor and Contributors\b/gu,
];

/**
 * What an allowed form is blanked to, column for column: neither a letter nor a digit, so it joins
 * no word, and not a space or a hyphen, so the words either side of it are not read as one term —
 * `control x-arkor-edge plane` says no control plane.
 */
const BLANK = '#';

function blankAllowed(text: string, allowed: readonly RegExp[]): string {
  let blanked = text;
  for (const pattern of allowed) {
    blanked = blanked.replaceAll(pattern, (match) => BLANK.repeat(match.length));
  }
  return blanked;
}

/** What opens a line that carries on a comment or a quote: `//`, `/*`, `*`, `#`, `>`. */
const OPENERS = new Set(['#', '*', '/', '>']);

/** A line with its indent and what opens it blanked, column for column: it reads as indent. */
function blankOpener(line: string): string {
  let end = line.length - line.trimStart().length;
  while (end < line.length && OPENERS.has(line.charAt(end))) {
    end += 1;
  }
  return ' '.repeat(end) + line.slice(end);
}

/**
 * Whitespace as a reader takes it, column for column. A run within a line, or across one line break
 * — a soft break, which Markdown renders as a space and a reader of a wrapped comment reads across —
 * becomes spaces; a run across two or more is a paragraph's end, and stays the line breaks it is.
 */
function softBreaksAsSpaces(text: string): string {
  return text.replaceAll(/\s+/gu, (space) =>
    space.indexOf('\n') === space.lastIndexOf('\n') ? ' '.repeat(space.length) : space,
  );
}

/**
 * Where an identifier's words meet: a capital after a lower-case letter or a digit (`controlPlane`),
 * the last capital of a run before a lower-case letter (`HTTPServer`), and what follows a `_`
 * (`control_plane`, which keeps its `_`).
 */
const WORD_JOIN = /(?<=[\da-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=_)(?=[\dA-Za-z])/gu;

/** A file as its terms are searched for, and the offset each of its characters has in the file. */
export interface Searchable {
  readonly text: string;
  readonly offsets: readonly number[];
}

/**
 * A file as its terms are searched for: what lines have shifted and what identifiers join read as
 * the words they are, `controlPlane` as `control Plane` and `control_plane` as `control_ plane`. A
 * space put between two words stands at the offset of the second.
 */
export function searchable(text: string, allowed: readonly RegExp[] = ALLOWED): Searchable {
  const opened = text
    .split('\n')
    .map((line) => blankOpener(line))
    .join('\n');
  const read = softBreaksAsSpaces(blankAllowed(opened, allowed));
  let spaced = '';
  const offsets: number[] = [];
  let from = 0;
  for (const join of [...read.matchAll(WORD_JOIN), { index: read.length }]) {
    for (let at = from; at < join.index; at += 1) {
      offsets.push(at);
    }
    spaced += read.slice(from, join.index);
    if (join.index < read.length) {
      offsets.push(join.index);
      spaced += ' ';
    }
    from = join.index;
  }
  return { text: spaced, offsets };
}
