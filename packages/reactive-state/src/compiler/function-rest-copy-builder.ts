import { type Node, type ObjectLiteralExpression } from 'typescript/ast';

/** Maximum distinct `(object, excludedKeys)` candidates materialized before conservatively collapsing. */
export const MAX_REST_COPY_CANDIDATES = 32;

export const EMPTY_EXCLUDED_KEYS: ReadonlySet<string> = new Set();
const EMPTY_TARGETS: ReadonlySet<Node> = new Set();

/** Shallow object-rest copy source together with statically excluded sibling keys. */
export interface ObjectRestCopy {
  readonly excludedKeys: ReadonlySet<string>;
  readonly object: ObjectLiteralExpression;
}

/** Bounded shallow object-rest copy resolution together with closure, target, and overflow state. */
export interface ObjectRestCopyResolution {
  readonly closed: boolean;
  readonly copies: readonly ObjectRestCopy[];
  readonly overflowed: boolean;
  readonly targets: ReadonlySet<Node>;
  readonly truncatedObjects: boolean;
}

export const EMPTY_UNCLOSED_REST_COPIES: ObjectRestCopyResolution = {
  closed: false,
  copies: [],
  overflowed: false,
  targets: EMPTY_TARGETS,
  truncatedObjects: false,
};

/** Bounded accumulator that stops materializing excluded-key combinations once `MAX_REST_COPY_CANDIDATES` overflows. */
export class RestCopyBuilder {
  private readonly keySignatures = new Map<ObjectLiteralExpression, Set<string>>();
  private readonly seenObjects = new Set<ObjectLiteralExpression>();
  private readonly targets = new Set<Node>();
  private unique: ObjectRestCopy[] = [];
  closed: boolean;
  overflowed = false;
  truncatedObjects = false;

  constructor(closed: boolean) {
    this.closed = closed;
  }

  private recordOverflowObject(object: ObjectLiteralExpression): void {
    if (this.seenObjects.has(object)) {
      return;
    }
    if (this.seenObjects.size >= MAX_REST_COPY_CANDIDATES) {
      this.truncatedObjects = true;
      return;
    }
    this.seenObjects.add(object);
    this.unique.push({ excludedKeys: EMPTY_EXCLUDED_KEYS, object });
  }

  private transitionToOverflow(): void {
    if (this.overflowed) {
      return;
    }
    this.overflowed = true;
    this.closed = false;
    this.keySignatures.clear();
    this.unique = Array.from(this.seenObjects, (object) => {
      return {
        excludedKeys: EMPTY_EXCLUDED_KEYS,
        object,
      };
    });
  }

  addCopy(object: ObjectLiteralExpression, excludedKeys: ReadonlySet<string>): void {
    if (this.overflowed) {
      this.recordOverflowObject(object);
      return;
    }
    const sig = excludedKeySignature(excludedKeys);
    let bucket = this.keySignatures.get(object);
    if (bucket?.has(sig) === true) {
      return;
    }
    if (this.unique.length >= MAX_REST_COPY_CANDIDATES) {
      this.transitionToOverflow();
      this.recordOverflowObject(object);
      return;
    }
    if (bucket === undefined) {
      bucket = new Set();
      this.keySignatures.set(object, bucket);
    }
    bucket.add(sig);
    this.seenObjects.add(object);
    this.unique.push({ excludedKeys, object });
  }

  addResolution(part: ObjectRestCopyResolution): void {
    if (!part.closed || part.copies.length === 0) {
      this.closed = false;
    }
    for (const target of part.targets) {
      this.targets.add(target);
    }
    if (part.truncatedObjects) {
      this.truncatedObjects = true;
    }
    if (part.overflowed) {
      this.transitionToOverflow();
      for (const copy of part.copies) {
        this.recordOverflowObject(copy.object);
      }
      return;
    }
    for (const copy of part.copies) {
      this.addCopy(copy.object, copy.excludedKeys);
    }
  }

  addTarget(target: Node): void {
    this.targets.add(target);
  }

  finish(): ObjectRestCopyResolution {
    if (!this.overflowed && this.unique.length === 0) {
      return EMPTY_UNCLOSED_REST_COPIES;
    }
    return {
      closed: this.closed && !this.overflowed && this.unique.length > 0,
      copies: this.unique,
      overflowed: this.overflowed,
      targets: this.targets,
      truncatedObjects: this.truncatedObjects,
    };
  }
}

/** Canonical length-prefixed signature for a statically excluded sibling key set. */
function excludedKeySignature(keys: ReadonlySet<string>): string {
  if (keys.size === 0) {
    return '';
  }
  return [...keys]
    .toSorted((left, right) => (left < right ? -1 : Number(left > right)))
    .map((key) => `${String(key.length)}:${key}`)
    .join('|');
}
