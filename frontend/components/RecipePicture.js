'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from './Language';
import styles from './RecipePicture.module.css';

// The recipe's picture at the top of its page. A tap opens it full screen, whole, where the
// browser's pinch-zoom works; ×, Escape or a tap anywhere closes it.
export default function RecipePicture({ picture, name }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className={styles.banner} aria-label={t.showPicture} onClick={() => setOpen(true)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image optimizer */}
        <img src={picture.url} alt={name} className={styles.bannerImage} />
      </button>
      {open && <Viewer url={picture.url} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function Viewer({ url, name, onClose }) {
  const { t } = useLanguage();
  const ref = useRef(null);

  useEffect(() => {
    ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={styles.viewer}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={onClose}
    >
      <button type="button" className={styles.close} aria-label={t.close} onClick={onClose}>
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image optimizer */}
      <img src={url} alt={name} className={styles.viewerImage} />
    </dialog>
  );
}
