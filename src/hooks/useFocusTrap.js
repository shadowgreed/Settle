import { useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// useFocusTrap — keyboard-accessible modal helper.
//
// When `isOpen` flips true:
//   1. Remembers the element that had focus before the modal opened
//   2. Moves focus to the first focusable element inside `containerRef`
//      (or to the container itself if none exists)
//   3. Cycles Tab / Shift-Tab between the first and last focusable
//      descendants so keyboard users can't reach the page underneath
// When `isOpen` flips false (or the component unmounts):
//   4. Restores focus to whatever had it before the modal opened
//
// WCAG 2.1.2 (No Keyboard Trap) + WAI-ARIA Modal Dialog pattern.
// ─────────────────────────────────────────────────────────────────────────────

// All natively focusable elements + anything with explicit tabindex.
// Negative tabindex is excluded; -1 means "focusable by script only".
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex^="-"])',
].join(',');

const getFocusable = (container) => {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    // Skip elements hidden via CSS — they exist in the DOM but can't actually
    // receive focus, and including them in the cycle dead-ends Tab navigation.
    (el) => !el.hasAttribute('hidden') && el.offsetParent !== null
  );
};

export default function useFocusTrap(containerRef, isOpen) {
  const previouslyFocusedRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // 1. Snapshot the currently-focused element so we can restore it on close.
    previouslyFocusedRef.current = document.activeElement;

    const container = containerRef.current;
    if (!container) return;

    // 2. Move focus into the modal. Prefer the first focusable child; fall
    //    back to the container itself (it needs tabindex="-1" for that to
    //    work — left to the caller, but we set it defensively).
    const focusables = getFocusable(container);
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      if (!container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1');
      }
      container.focus();
    }

    // 3. Tab / Shift-Tab cycling.
    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last  = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    container.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // 4. Restore focus. Guarded because the element might have been removed
      //    from the DOM while the modal was open.
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [isOpen, containerRef]);
}
