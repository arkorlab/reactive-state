import type { Frame } from '../program.ts';
import { sessionTag, signSubscription } from './bindings.ts';
import { digest } from './canonical.ts';
import type { Core, Session } from './model.ts';
import type { Root, View } from './views.ts';

/** Writes to fields a frame lists as reflected; older ones settle by their revision. */
const REFLECTED_OPERATIONS = 256;

/**
 * The frame a page's render is shown at: the root's key for the session, the revision, the
 * fields' values, the session's writes it reflects, what it shows, and — where there is a
 * session to follow it — the subscription its event stream follows it by.
 */
export function frameOf(core: Core, session: Session | undefined, root: Root, view: View): Frame {
  const { buildId } = core.registry;
  const tag = session === undefined ? '' : sessionTag(core.secret, session.id);
  const followed = session !== undefined && view.status !== 'unauthenticated';
  return {
    buildId,
    digest: view.digest,
    fields: view.assembly.fields,
    operations:
      session === undefined
        ? []
        : core.db.fieldOperations(session.id, view.revision, REFLECTED_OPERATIONS),
    revision: view.revision,
    rootKey: digest([root.component, root.props, tag, buildId]),
    subscription: followed
      ? signSubscription(core.secret, {
          build: buildId,
          digest: view.digest,
          revision: view.revision,
          root,
          session: session.id,
          view: view.named,
        })
      : '',
    view: view.shown,
  };
}
