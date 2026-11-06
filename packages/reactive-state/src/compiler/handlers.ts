import {
  isAsExpression,
  isBinaryExpression,
  isConditionalExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningLikeElement,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  type JsxAttribute,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

/**
 * What the attribute a function is given to does with it: the handler of an event a person's action
 * dispatches, which a setter is called from (`updaters.ts`), or what React calls itself as the
 * element commits, with nobody doing anything — a ref, an event that fires by itself.
 */

/**
 * The events a person's own action dispatches, by React's names for their props; a capture phase's
 * (`onClickCapture`) too. Others fire as the page renders and commits — `onLoad` and `onError` as
 * an element mounts, `onFocus` as one with `autoFocus` does, `onToggle`, `onScroll`,
 * `onAnimationEnd`, `onMouseEnter` under a pointer that stays still — so a write that remounts the
 * element would fire them again, and write again, with nobody doing anything.
 */
const USER_EVENTS: ReadonlySet<string> = new Set(
  [
    'onAuxClick onBeforeInput onChange onClick onCompositionEnd onContextMenu onCopy onCut',
    'onDoubleClick onDragEnd onDragStart onDrop onInput onKeyDown onKeyUp onMouseDown onMouseUp',
    'onPaste onPointerDown onPointerUp onReset onSubmit onTouchEnd onTouchStart',
  ]
    .join(' ')
    .split(' '),
);

/**
 * The props React DOM (19.3) names the other events by. A component given one may hand it to an
 * element of the browser's, where it fires as that element's does, so a component is refused them
 * too; a prop of a name of its own — `onCheckedChange` — is the component's to call, as its name
 * says.
 */
const OTHER_DOM_EVENTS: ReadonlySet<string> = new Set(
  [
    'onAbort onAnimationEnd onAnimationIteration onAnimationStart onBeforeToggle onBlur onCancel',
    'onCanPlay onCanPlayThrough onClose onCompositionStart onCompositionUpdate onDrag onDragEnter',
    'onDragExit onDragLeave onDragOver onDurationChange onEmptied onEncrypted onEnded onError',
    'onFocus onFullscreenChange onFullscreenError onGotPointerCapture onInvalid onKeyPress onLoad',
    'onLoadedData onLoadedMetadata onLoadStart onLostPointerCapture onMouseEnter onMouseLeave',
    'onMouseMove onMouseOut onMouseOver onPause onPlay onPlaying onPointerCancel onPointerEnter',
    'onPointerLeave onPointerMove onPointerOut onPointerOver onProgress onRateChange onResize',
    'onScroll onScrollEnd onSeeked onSeeking onSelect onStalled onSuspend onTimeUpdate onToggle',
    'onTouchCancel onTouchMove onTransitionCancel onTransitionEnd onTransitionRun onTransitionStart',
    'onVolumeChange onWaiting onWheel',
  ]
    .join(' ')
    .split(' '),
);

/** The operators that answer one of their operands. */
const ANSWERING: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether `node` is given as it is to a component's handler — `<TextInput onChange={setTitle} />`
 * — which calls it with the value it reports. An element of the browser's own would call it with an
 * event, which no field holds.
 */
export function isComponentHandlerValue(node: Node): boolean {
  const attribute = handlerAttributeOf(node);
  return attribute !== undefined && isComponent(attribute);
}

/** Whether an attribute is a component's: one of a tag that names a value, `<TextInput>`, `<ui.Field>`. */
function isComponent(attribute: JsxAttribute): boolean {
  const element = attribute.parent.parent;
  if (!isJsxOpeningLikeElement(element)) {
    return false;
  }
  const tag = element.tagName;
  return (
    isPropertyAccessExpression(tag) ||
    (isIdentifier(tag) && !/^[a-z]/u.test(tag.text) && !tag.text.includes('-'))
  );
}

/**
 * The attribute `node` is given to as its value, where that attribute is the handler of an event a
 * person's action dispatches: `onClick={…}` of an element of the browser's, or of a component's,
 * whose handler of a name of its own — `onCheckedChange={…}` — it calls as its name says.
 */
export function handlerAttributeOf(node: Node): JsxAttribute | undefined {
  let parent = node.parent;
  while (isParenthesizedExpression(parent)) {
    parent = parent.parent;
  }
  if (!isJsxExpression(parent) || !isJsxAttribute(parent.parent)) {
    return undefined;
  }
  const attribute = parent.parent;
  if (!isIdentifier(attribute.name)) {
    return undefined;
  }
  const event = eventName(attribute.name.text);
  const handles =
    USER_EVENTS.has(event) ||
    (isComponent(attribute) && /^on[A-Z]/u.test(event) && !OTHER_DOM_EVENTS.has(event));
  return handles ? attribute : undefined;
}

/**
 * The name of the attribute `node` is given to — through parentheses, a cast, either answer of a
 * condition, an operand of `&&`, `||` or `??` — where React calls what it is given itself, as the
 * element commits, with nobody doing anything: `ref`, of any element, which it calls again on each
 * commit it is given a new function on, and an event of an element of the browser's but those a
 * person's action dispatches, which fires by itself — `onLoad` as the element mounts, `onFocus` as
 * one with `autoFocus` does; none of another.
 */
export function committedAttributeOf(node: Node): string | undefined {
  let each = node;
  while (answersAsItIs(each)) {
    each = each.parent;
  }
  const { parent } = each;
  if (!isJsxExpression(parent) || !isJsxAttribute(parent.parent)) {
    return undefined;
  }
  const attribute = parent.parent;
  if (!isIdentifier(attribute.name)) {
    return undefined;
  }
  const name = attribute.name.text;
  const event = eventName(name);
  const fires = !isComponent(attribute) && /^on[A-Z]/u.test(event) && !USER_EVENTS.has(event);
  return name === 'ref' || fires ? name : undefined;
}

/** Known event names retain Capture when it is part of their name, before reading a phase suffix. */
function eventName(name: string): string {
  return USER_EVENTS.has(name) || OTHER_DOM_EVENTS.has(name) ? name : name.replace(/Capture$/u, '');
}

/** Whether what `node` stands in answers it as it is, or may: parentheses, a cast, a condition's answer, `&&`, `||`, `??`. */
function answersAsItIs(node: Node): boolean {
  const { parent } = node;
  if (
    isParenthesizedExpression(parent) ||
    isAsExpression(parent) ||
    isSatisfiesExpression(parent) ||
    isNonNullExpression(parent)
  ) {
    return true;
  }
  if (isConditionalExpression(parent)) {
    return parent.condition !== node;
  }
  return isBinaryExpression(parent) && ANSWERING.has(parent.operatorToken.kind);
}
