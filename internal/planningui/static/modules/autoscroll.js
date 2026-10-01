// Edge auto-scroll while a card or column is dragged. The browser's own drag
// autoscroll only reacts in a thin band at the window edge, at one slow speed,
// and never inside a scrolling column. Here the scroller under the pointer
// scrolls whenever the pointer is in a wide band along its edge, faster the
// closer to the edge, until the drag ends.
import { useEffect, useRef } from './vendor-preact.js';
import { useEventListener } from './ui-hooks.js';

/** Fastest scroll, in pixels per second, with the pointer on the edge. */
export const MAX_SPEED = 900;
// A drag over the page reports about every 50–350ms; a longer silence means
// the pointer left the window, so scrolling stops instead of running on.
const STALE_MS = 800;
const MIN_ZONE = 48;
const MAX_ZONE = 120;

/**
 * Speed for a pointer `depth` pixels into an edge band of width `zone`: none at
 * the band's inner border, rising smoothly to MAX_SPEED at the edge.
 * @param {number} depth
 * @param {number} zone
 */
export function edgeSpeed(depth, zone) {
  if (depth <= 0 || zone <= 0) return 0;
  const ratio = Math.min(depth / zone, 1);
  return MAX_SPEED * ratio * ratio;
}
// Signed speed along one axis of a scroller spanning `start`–`end`: negative
// toward the start edge, positive toward the end edge. The bands are a fifth of
// the size, between 48 and 120px, and never overlap.
/**
 * @param {number} position
 * @param {number} start
 * @param {number} end
 */
export function axisSpeed(position, start, end) {
  const size = end - start;
  if (size <= 0) return 0;
  const zone = Math.min(Math.max(size / 5, MIN_ZONE), MAX_ZONE, size / 2);
  if (position < start + zone) return -edgeSpeed(start + zone - position, zone);
  if (position > end - zone) return edgeSpeed(position - (end - zone), zone);
  return 0;
}

/** @typedef {{ element: Element, left: number, right: number, top: number, bottom: number }} Scroller */
/**
 * @param {Element} element
 * @param {'x' | 'y'} axis
 */
function scrollsOn(element, axis) {
  const style = getComputedStyle(element);
  const overflow = axis === 'x' ? style.overflowX : style.overflowY;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return axis === 'x'
    ? element.scrollWidth > element.clientWidth
    : element.scrollHeight > element.clientHeight;
}
// Scrollers from the element under the pointer outwards, each with the part of
// it that is on screen, ending with the page itself.
/**
 * @param {Element | null} start
 * @returns {Scroller[]}
 */
function scrollerChain(start) {
  const root = document.scrollingElement;
  /** @type {Scroller[]} */
  const chain = [];
  for (let element = start; element && element !== root; element = element.parentElement) {
    if (!scrollsOn(element, 'x') && !scrollsOn(element, 'y')) continue;
    const box = element.getBoundingClientRect();
    chain.push({
      element,
      left: Math.max(box.left, 0),
      right: Math.min(box.right, innerWidth),
      top: Math.max(box.top, 0),
      bottom: Math.min(box.bottom, innerHeight),
    });
  }
  if (root) chain.push({ element: root, left: 0, right: innerWidth, top: 0, bottom: innerHeight });
  return chain;
}
/**
 * @param {Element} element
 * @param {'x' | 'y'} axis
 * @param {number} direction
 */
function hasRoom(element, axis, direction) {
  const position = axis === 'x' ? element.scrollLeft : element.scrollTop;
  const max =
    axis === 'x'
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;
  return direction < 0 ? position > 0 : position < max - 1;
}
// The innermost scroller whose edge band holds the pointer and that can still
// move that way.
/**
 * @param {Scroller[]} chain
 * @param {'x' | 'y'} axis
 * @param {number} x
 * @param {number} y
 */
function pickScroller(chain, axis, x, y) {
  for (const scroller of chain) {
    if (scroller.element !== document.scrollingElement && !scrollsOn(scroller.element, axis))
      continue;
    const speed =
      axis === 'x'
        ? axisSpeed(x, scroller.left, scroller.right)
        : axisSpeed(y, scroller.top, scroller.bottom);
    if (speed && hasRoom(scroller.element, axis, speed))
      return { element: scroller.element, speed };
  }
  return undefined;
}

// Scrolls under the pointer while `active()` holds, driven by the drag-over
// events the page receives and a frame loop that keeps scrolling when the
// pointer rests in an edge band.
/** @param {() => boolean} active */
export function useEdgeAutoScroll(active) {
  const activeNow = useRef(active);
  activeNow.current = active;
  const lastDrag = useRef({ x: 0, y: 0, at: 0 });
  const frame = useRef(0);
  const clock = useRef(0);
  const carry = useRef({ x: 0, y: 0 });
  const tick = useRef(/** @type {FrameRequestCallback} */ (() => {}));
  // Scroll snapping pulls every small step back to the nearest snap point, so a
  // scroller driven from here stops snapping until the loop ends.
  const held = useRef(/** @type {Set<HTMLElement>} */ (new Set()));
  const release = () => {
    for (const element of held.current) element.style.removeProperty('scroll-snap-type');
    held.current.clear();
  };
  const hold = (/** @type {Element} */ element) => {
    const node = /** @type {HTMLElement} */ (element);
    if (held.current.has(node)) return;
    node.style.setProperty('scroll-snap-type', 'none');
    held.current.add(node);
  };
  tick.current = (time) => {
    frame.current = 0;
    const { x, y, at } = lastDrag.current;
    if (!activeNow.current() || performance.now() - at > STALE_MS) {
      release();
      return;
    }
    const seconds = Math.min((time - clock.current) / 1000, 0.05);
    clock.current = time;
    const chain = scrollerChain(document.elementFromPoint(x, y));
    const horizontal = pickScroller(chain, 'x', x, y);
    const vertical = pickScroller(chain, 'y', x, y);
    if (horizontal) hold(horizontal.element);
    if (vertical) hold(vertical.element);
    if (horizontal) {
      carry.current.x += horizontal.speed * seconds;
      const step = Math.trunc(carry.current.x);
      carry.current.x -= step;
      horizontal.element.scrollLeft += step;
    }
    if (vertical) {
      carry.current.y += vertical.speed * seconds;
      const step = Math.trunc(carry.current.y);
      carry.current.y -= step;
      vertical.element.scrollTop += step;
    }
    frame.current = requestAnimationFrame((next) => tick.current(next));
  };
  // Capture phase: drop zones stop the event before it reaches the document.
  useEventListener(
    document,
    'dragover',
    (event) => {
      if (!activeNow.current()) return;
      lastDrag.current = { x: event.clientX, y: event.clientY, at: performance.now() };
      if (frame.current) return;
      clock.current = performance.now();
      carry.current = { x: 0, y: 0 };
      frame.current = requestAnimationFrame((time) => tick.current(time));
    },
    { capture: true },
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      release();
    },
    [],
  );
}
