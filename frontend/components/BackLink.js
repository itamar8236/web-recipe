'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import { isSwipeBack } from '@/lib/swipe';

// Whether the touch began where a sideways move means something else: typing or
// selecting in a field, a row that scrolls sideways, or a popup (like the picture viewer).
function startsInOwnGesture(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], dialog')) return true;
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    const { overflowX } = getComputedStyle(el);
    if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) return true;
  }
  return false;
}

// The Back link, which also follows a sideways swipe anywhere on the page (left to right
// in English, right to left in Hebrew), so every screen with Back gets the gesture.
export default function BackLink({ className, children }) {
  const { lang } = useLanguage();
  const router = useRouter();

  useEffect(() => {
    let start = null;

    function onStart(event) {
      const zoomed = window.visualViewport && window.visualViewport.scale > 1;
      if (event.touches.length !== 1 || zoomed || startsInOwnGesture(event.target)) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    }

    function onEnd(event) {
      if (!start || event.touches.length > 0) {
        start = null;
        return;
      }
      const touch = event.changedTouches[0];
      const swipe = {
        dx: touch.clientX - start.x,
        dy: touch.clientY - start.y,
        ms: Date.now() - start.time,
        dir: lang === 'he' ? 'rtl' : 'ltr',
      };
      start = null;
      if (isSwipeBack(swipe)) router.push('/');
    }

    // A second finger (a pinch), or the browser taking the touch over, cancels the swipe.
    function onMove(event) {
      if (event.touches.length > 1) start = null;
    }

    function onCancel() {
      start = null;
    }

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
    };
  }, [lang, router]);

  return (
    <Link href="/" className={className}>
      {children}
    </Link>
  );
}
