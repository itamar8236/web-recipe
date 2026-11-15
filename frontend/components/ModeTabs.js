'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLanguage } from './Language';
import styles from './ModeTabs.module.css';

const TABS = [
  { key: 'mine', href: '/', label: 'myRecipesTab' },
  { key: 'browse', href: '/browse', label: 'browseTab' },
];
const PHONE = '(max-width: 759px)';
const SWIPE_MIN = 60; // px a finger must travel sideways to count as a swipe

// True when the touch began on something that itself scrolls sideways (the tag pills), or
// in a text field, where a sideways drag already means something else.
function ownsSidewaysDrag(element, stop) {
  for (let node = element; node && node !== stop; node = node.parentElement) {
    if (node.matches('input, textarea')) return true;
    if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
  }
  return false;
}

// The switch between the user's own recipes (Home) and other users' recipes (Browse), with
// the page under it as `children`. `current` is 'mine' or 'browse'. With `show` false (a
// guest: browsing needs an account) it renders only the page.
//
// On a phone the tabs are a secondary control: the page opens scrolled just past them, so
// the content is at the top and scrolling up reveals them, and a sideways swipe anywhere on
// the page switches between the two.
export default function ModeTabs({ current, show = true, children }) {
  const { lang, t } = useLanguage();
  const router = useRouter();
  const body = useRef(null);
  const touch = useRef(null);

  useEffect(() => {
    if (!show || !window.matchMedia(PHONE).matches) return;
    const header = document.querySelector('header');
    const top = body.current.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - (header?.offsetHeight ?? 0) - 8));
  }, [show]);

  if (!show) return children;

  function onTouchStart(event) {
    const point = event.touches[0];
    touch.current =
      event.touches.length === 1 && !ownsSidewaysDrag(event.target, body.current)
        ? { x: point.clientX, y: point.clientY }
        : null;
  }

  // Swiping moves to the tab on the side the finger came from, like turning a page: in
  // English "From others" is on the right, so a swipe to the left opens it; Hebrew mirrors.
  function onTouchEnd(event) {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const point = event.changedTouches[0];
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const forward = lang === 'he' ? dx > 0 : dx < 0;
    const target = forward ? 'browse' : 'mine';
    if (target !== current) router.push(TABS.find((tab) => tab.key === target).href);
  }

  return (
    <>
      <nav className={styles.tabs} aria-label={t.recipesNav}>
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={`${styles.tab} ${tab.key === current ? styles.active : ''}`}
            aria-current={tab.key === current ? 'page' : undefined}
          >
            {t[tab.label]}
          </Link>
        ))}
      </nav>
      <div ref={body} className={styles.body} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {children}
      </div>
    </>
  );
}
