import { useEffect, useRef } from 'react';

/**
 * Close the TOPMOST open dialog on Escape, and only that one.
 *
 * Every dialog registering its own `window` keydown listener is the obvious
 * implementation and it is wrong, because Escape is not addressed to a
 * particular listener: it fires all of them. Open the trash, press Ctrl+P to
 * bring the command palette up over it, then press Escape to back out of the
 * palette, and both close. The user asked to dismiss one thing and lost two.
 *
 * Handling it inside each dialog cannot fix this either. `stopPropagation()` on
 * a React synthetic event does not help: React 18 attaches a single native
 * listener at the root container, so by the time a component sees the event it
 * has already been dispatched and it continues on to document and window
 * regardless. `stopImmediatePropagation()` on the native event would work, but
 * only by making whichever component happens to run first the winner, which is a
 * race dressed up as a fix.
 *
 * So the stack lives here, module-level, and there is exactly one listener for
 * the whole app. Last registered is topmost, which matches the order dialogs
 * actually open in, and it stays correct without any dialog needing to know
 * about z-index or about which other dialogs exist.
 */
type CloseFn = () => void;

const stack: CloseFn[] = [];
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Consume it. Without this a dialog closes AND an editor keymap underneath
  // acts on the same press, which is the two-for-one dismissal in a different
  // disguise.
  e.stopPropagation();
  e.preventDefault();
  top();
}

/**
 * Capture phase, so a dialog wins over a keymap bound further down the tree.
 * Dismissing the thing you are looking at is what a user means by Escape, and
 * the editor underneath is not what has their attention.
 */
function attach() {
  if (listening) return;
  window.addEventListener('keydown', onKeyDown, true);
  listening = true;
}

function detach() {
  if (!listening || stack.length > 0) return;
  window.removeEventListener('keydown', onKeyDown, true);
  listening = false;
}

/**
 * Register `onClose` as the Escape target while `isOpen` is true.
 *
 * `onClose` is held in a ref and deliberately kept OUT of the effect's
 * dependencies. Callers overwhelmingly pass an inline arrow, so depending on it
 * would unregister and re-register on every render, and a dialog re-rendering
 * while another is open would silently promote itself to the top of the stack.
 * The ref is reassigned on every render instead, so the entry stays in place and
 * still calls the current callback rather than a stale closure.
 */
export function useEscapeToClose(isOpen: boolean, onClose: CloseFn): void {
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const entry: CloseFn = () => latest.current();
    stack.push(entry);
    attach();
    return () => {
      // lastIndexOf, not indexOf: two dialogs could hold identically-behaving
      // entries, and removing the wrong one would leave a closed dialog on the
      // stack swallowing Escape forever.
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      detach();
    };
  }, [isOpen]);
}
