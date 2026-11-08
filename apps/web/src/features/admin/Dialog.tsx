import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Admin.module.scss';

/** Modal sheet used for secondary admin tools so they never push the dashboard layout. */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className={styles.dialogBody}>
          <header className={styles.dialogHead}>
            <h2>{title}</h2>
            <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
