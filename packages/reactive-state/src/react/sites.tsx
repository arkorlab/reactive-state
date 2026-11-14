import {
  type ReactElement,
  type ReactNode,
  use,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';

import type { ClientPart, Json, RenderedSite, SiteInputs } from '../program.ts';
import { canonicalJson, toJson, toJsonRecord } from '../runtime/json.ts';
import { type Live, LiveContext } from './state.ts';

/**
 * The dynamic sites of a compiled Client Component: the reactive components its JSX renders with
 * values of its local states, each shown as the authority rendered it for those values. The part
 * names each site it renders with the inputs it renders it with (`of`), and the states the
 * conditions it stands under alone read, which the authority checks them with again; what it names
 * as it commits is what the page shows, and the root is rendered again for a site it was not
 * rendered for. What a site shows is the authority's rendering of its inputs: one of other values
 * of the states its conditions alone read shows the same, while the root is rendered again for them.
 *
 * A list site — the reactive component the part renders for each item of an array of its inputs, in
 * a keyed `.map()` — is named by each item (`item`), with the whole array: what an item shows is the
 * authority's rendering of that item, by its key and the item itself, whatever order the array holds
 * them in now. Items moved show what they showed while the root is rendered again for the order;
 * an item of another value, or a new one, waits for the root rendered again; items opened together
 * are asked for together.
 *
 * What the page cannot send the authority of a site — inputs, or an item, that JSON does not carry
 * as they are: `NaN` a page computed, a function — fails where the site stands, as the authority's
 * refusal of a site does, and the rest of the part renders: the authority starts no list of such an
 * item, and refuses it.
 *
 * A site whose rendering the part does not have yet waits for it — as a child of the part, so the
 * nearest `<Suspense>` inside the part shows its fallback, and the rest of the part stays as it is.
 * A site the part has a rendering of for other inputs only, rendered with the inputs it showed when
 * it last committed, keeps showing what it showed, with the frame it came with: the part rendered
 * as it is, while a transition of it waits for inputs the root was rendered again for — which would
 * otherwise wait in turn for the inputs it moves away from. On the server, which asks for nothing,
 * a site is left to the browser: the boundary around it is rendered there, never awaited.
 */

/**
 * The values of the states a site is rendered of, by key: JSON, which each call checks — typed as
 * the part holds them, of whatever types its states are declared with.
 */
type Inputs = Readonly<Record<string, unknown>>;

/** An item of a list site, as the part's `.map()` names it: its key, and the item it is handed. */
interface ListEntry {
  readonly key: number | string;
  readonly item: unknown;
}

export interface Sites {
  /**
   * What the site `site` shows with `inputs`: the authority's rendering of it, once it has one.
   * `guarded` are the states the conditions it stands under read, and it is not rendered of: the
   * page sends them beside its inputs, for the authority to check the conditions with.
   */
  readonly of: (site: string, inputs: Inputs, guarded?: Inputs) => ReactElement;
  /**
   * What the item `entry` of the list site `site` shows: the authority's rendering of the item —
   * the element of an array of `inputs` the part's `.map()` is handed — by its key, once it has
   * one, keyed by the site and the item's key, apart from another list's item in its place. `guarded`
   * as for `of`.
   */
  readonly item: (site: string, inputs: Inputs, entry: ListEntry, guarded?: Inputs) => ReactElement;
}

interface SiteProps {
  readonly part: ClientPart<ReactNode>;
  readonly site: string;
  /** The states it is rendered of. */
  readonly inputs: SiteInputs;
  /** What the page sends for it: its inputs, and the states its conditions alone read. */
  readonly sent: SiteInputs;
}

interface ItemProps extends SiteProps {
  /** The item's key, as text, as React keeps one. */
  readonly itemKey: string;
  readonly item: Json;
}

/**
 * What a site showed: of which part's site and for which inputs — or which item — and under the
 * root and frame it was rendered with.
 */
interface Shown {
  readonly key: string;
  readonly content: ReactNode;
  readonly live: Live | null;
}

/** What a site, or an item of a list, is shown by. */
interface Showing extends Omit<SiteProps, 'inputs'> {
  /** What the frame the part came with rendered for it, if it rendered it. */
  readonly found: { readonly content: ReactNode } | undefined;
  /** What it shows is of: which part's site, for which inputs or item. */
  readonly key: string;
  /**
   * Why it waits for nothing, where the frame was rendered for the very inputs the page sends and
   * holds no rendering of it: another frame of them would hold none either.
   */
  readonly missing: string | undefined;
}

function own(target: Record<string, SiteInputs>, name: string, value: SiteInputs): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Of the inputs a site was rendered for, those it is rendered of, `like` names: its own. */
function ownInputs(rendered: SiteInputs, like: SiteInputs): SiteInputs {
  const inputs: Record<string, SiteInputs[string]> = {};
  for (const name of Object.keys(like)) {
    if (Object.hasOwn(rendered, name)) {
      Object.defineProperty(inputs, name, { enumerable: true, value: rendered[name] });
    }
  }
  return inputs;
}

/** Whether a site was rendered for `inputs`, those it is rendered of. */
function renderedFor(rendered: RenderedSite<ReactNode>, inputs: SiteInputs): boolean {
  return canonicalJson(ownInputs(rendered.inputs, inputs)) === canonicalJson(inputs);
}

/** What the authority rendered at `site` of `part`, if it rendered it. */
function renderedOf(
  part: ClientPart<ReactNode>,
  site: string,
): RenderedSite<ReactNode> | undefined {
  const { sites } = part;
  return sites !== undefined && Object.hasOwn(sites, site) ? sites[site] : undefined;
}

/**
 * What a site, or an item, shows: what the frame rendered for it, or what it showed when it last
 * committed, of the same root; or it waits for the root rendered again for it.
 */
function useShowing({ found, key, missing, part, sent, site }: Showing): ReactNode {
  const live = useContext(LiveContext);
  const last = useRef<Shown | null>(null);
  let shown: Shown | undefined;
  if (found !== undefined) {
    shown = { content: found.content, key, live };
  } else if (
    missing === undefined &&
    last.current?.key === key &&
    last.current.live?.sites === live?.sites
  ) {
    // What it showed for these inputs when it last committed, of the same root.
    shown = last.current;
  }
  useLayoutEffect(() => {
    if (shown !== undefined) {
      last.current = shown;
    }
  });
  if (shown !== undefined) {
    // Under the frame its content was rendered at: what it shows is never of another revision.
    return <LiveContext value={shown.live}>{shown.content}</LiveContext>;
  }
  if (missing !== undefined) {
    throw new Error(missing);
  }
  if (live === null) {
    throw new Error('A dynamic site is rendered inside <LiveRoot>, which renderRoot renders.');
  }
  const { instance } = part;
  if (instance === undefined) {
    throw new Error(
      `The authority rendered no instance of the component whose site "${site}" is rendered: compile the application again.`,
    );
  }
  if (live.sites === null) {
    // Thrown, for React to render the boundary around it in the browser.
    throw new Error(
      `The site "${site}" was rendered for other inputs than these: the browser renders it.`,
    );
  }
  live.sites.ensure(instance, site, sent);
  use(live.sites.waitFor(instance, site, sent));
  // A wait ends once the root committed another frame, after which the part renders this anew.
  return null;
}

/**
 * Why the authority rendered `rendered` nothing of `sent`, all the page sends for it: its inputs,
 * and the states its conditions alone read, which a refusal may be of — its guard's, refused — as
 * what it rendered of its inputs is not, which shows under whichever guard lets it show.
 */
function refusalOf(
  rendered: RenderedSite<ReactNode> | undefined,
  sent: SiteInputs,
): string | undefined {
  return rendered?.refused !== undefined && renderedFor(rendered, sent)
    ? rendered.refused.message
    : undefined;
}

/** What a site, or an item, shows whose inputs or item the page cannot send: why, thrown. */
function Unsent({ error }: { readonly error: unknown }): ReactNode {
  throw error;
}

/** What `make` makes, or what it threw. */
function attempt<T>(make: () => T): { readonly made: T } | { readonly error: unknown } {
  try {
    return { made: make() };
  } catch (error) {
    return { error };
  }
}

/** Only a valid runtime list key is converted; untyped values fail inside the item's own child. */
function itemKeyOf(key: unknown, site: string): string {
  if (!(typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key)))) {
    throw new TypeError(`An item of the list ${site} has no key of text or a number.`);
  }
  return String(key);
}

/**
 * The values `inputs` hold, each after its key, where they hold them as an object literal does —
 * each its own, enumerated, and not computed, as `toJsonRecord` copies it — and nothing otherwise.
 */
function heldBy(inputs: Inputs): readonly unknown[] | undefined {
  if (Object.getPrototypeOf(inputs) !== Object.prototype) {
    return undefined;
  }
  const held: unknown[] = [];
  for (const name of Reflect.ownKeys(inputs)) {
    const descriptor = Object.getOwnPropertyDescriptor(inputs, name);
    if (typeof name !== 'string' || descriptor?.enumerable !== true || !('value' in descriptor)) {
      return undefined;
    }
    held.push(name, descriptor.value);
  }
  return held;
}

/** Whether two inputs held the very same values by the same keys (`heldBy`). */
function heldAlike(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** What a list site sends, as a render copied it for an item, and what was copied (`heldBy`). */
interface Listed {
  readonly inputs: readonly unknown[] | undefined;
  readonly guarded: readonly unknown[] | undefined;
  readonly made: Pick<SiteProps, 'inputs' | 'sent'>;
}

function SiteContent({ inputs, part, sent, site }: SiteProps): ReactNode {
  const rendered = renderedOf(part, site);
  const found =
    rendered?.content !== undefined && renderedFor(rendered, inputs) ? rendered : undefined;
  // What it shows is of one site of one part, for these inputs: another at the same place in the
  // JSX, though its inputs read the same, shows nothing this one showed.
  const key = canonicalJson([part.instance ?? null, site, inputs]);
  return useShowing({ found, key, missing: refusalOf(rendered, sent), part, sent, site });
}

function ItemContent({ inputs, item, itemKey, part, sent, site }: ItemProps): ReactNode {
  const rendered = renderedOf(part, site);
  const held = canonicalJson(item);
  const found = rendered?.items?.find(
    (each) => each.key === itemKey && canonicalJson(each.item) === held,
  );
  const missing =
    found === undefined && rendered?.items !== undefined && renderedFor(rendered, inputs)
      ? `The authority rendered the list "${site}" of the inputs the page sends with no item "${itemKey}" of this value: the page lists what the authority does not.`
      : refusalOf(rendered, sent);
  // What it shows is of one item of one site of one part: the item of another value, though of
  // the same key, shows nothing this one showed.
  const key = canonicalJson([part.instance ?? null, site, itemKey, item]);
  return useShowing({ found, key, missing, part, sent, site });
}

/**
 * The sites of `part`, as its Client Component renders them. Each render names the sites it
 * renders; as it commits, the root is told what the part shows, and once the part is no longer
 * rendered, that it shows nothing.
 */
export function useSites(part: ClientPart<ReactNode>): Sites {
  const controller = useContext(LiveContext)?.sites ?? null;
  const { instance } = part;
  // The sites this render names, by id.
  const named: Record<string, SiteInputs> = {};
  // The items of no key this render names, each keyed apart from the others — siblings, as items
  // of one list are, which React keeps apart by their keys — though each of them fails at once.
  let unkeyed = 0;
  useEffect(() => {
    if (controller !== null && instance !== undefined) {
      controller.commit(instance, named);
    }
  });
  useEffect(() => {
    if (controller === null || instance === undefined) {
      return;
    }
    return () => {
      controller.release(instance);
    };
  }, [controller, instance]);
  /** The inputs of `site`, a copy of their JSON, and what the page sends for it, named so. */
  const sending = (
    site: string,
    inputs: Inputs,
    guarded: Inputs,
  ): Pick<SiteProps, 'inputs' | 'sent'> => {
    const what = `The inputs of the site "${site}"`;
    const sent = toJsonRecord({ ...guarded, ...inputs }, what);
    own(named, site, sent);
    return { inputs: toJsonRecord(inputs, what), sent };
  };
  // What each list site this render names sends, as it was copied for an item: every item of the
  // part's `.map()` names it again, with the same array, which a long list would otherwise copy
  // once for each of its items.
  let listed: Map<string, Listed> | undefined;
  /**
   * What the list site `site` sends, as `sending` makes it: the copy made for an item before it in
   * this render, where its inputs, and the states its conditions alone read, hold the very values
   * they held then — which the render, as React's rules have it, changes nothing of.
   */
  const listing = (
    site: string,
    inputs: Inputs,
    guarded: Inputs,
  ): Pick<SiteProps, 'inputs' | 'sent'> => {
    const held = { guarded: heldBy(guarded), inputs: heldBy(inputs) };
    const last = listed?.get(site);
    if (
      last !== undefined &&
      heldAlike(last.inputs, held.inputs) &&
      heldAlike(last.guarded, held.guarded)
    ) {
      // Named as each call names its site.
      own(named, site, last.made.sent);
      return last.made;
    }
    const made = sending(site, inputs, guarded);
    listed ??= new Map();
    listed.set(site, { ...held, made });
    return made;
  };
  return {
    item: (site, inputs, entry, guarded = {}) => {
      const keyed = attempt(() => itemKeyOf(entry.key, site));
      if (!('made' in keyed)) {
        unkeyed += 1;
        // Keyed by its place alone, of no colon: apart from every item of a key, which is keyed
        // `site:key`, whatever its site and its key hold.
        return <Unsent error={keyed.error} key={`#${String(unkeyed)}`} />;
      }
      const itemKey = keyed.made;
      const key = `${site}:${itemKey}`;
      const attempted = attempt(() => {
        const held = toJson(entry.item, `The item "${itemKey}" of the site "${site}"`);
        return { held, ...listing(site, inputs, guarded) };
      });
      if (!('made' in attempted)) {
        return <Unsent error={attempted.error} key={key} />;
      }
      const { held, inputs: copied, sent } = attempted.made;
      return (
        <ItemContent
          inputs={copied}
          item={held}
          itemKey={itemKey}
          key={key}
          part={part}
          sent={sent}
          site={site}
        />
      );
    },
    of: (site, inputs, guarded = {}) => {
      const attempted = attempt(() => sending(site, inputs, guarded));
      if (!('made' in attempted)) {
        return <Unsent error={attempted.error} key={site} />;
      }
      const { inputs: copied, sent } = attempted.made;
      return <SiteContent inputs={copied} key={site} part={part} sent={sent} site={site} />;
    },
  };
}
