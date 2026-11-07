import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pin, PinOff } from 'lucide-react';
import { isEligible, type FeedState, type Follow, type SlotId } from '@sportlight/shared';
import { SportIcon } from '../../components/SportIcon';
import { screenNumber } from '../../lib/live-ui';
import styles from './FeedPicker.module.scss';

export interface FeedPickerProps {
  slot: SlotId;
  /** The element that opened the picker (positioning and focus return). */
  anchor: HTMLElement;
  feeds: readonly FeedState[];
  follows: readonly Follow[];
  assignment: Record<SlotId, FeedState | null>;
  pinned: boolean;
  onPin: (slot: SlotId, pinned: boolean) => void;
  onChoose: (slot: SlotId, feedId: string) => void;
  onClose: () => void;
}

const WIDTH = 300;
const GAP = 6;

/**
 * "Show on screen N": every live feed (the viewer's sports first, by intensity). Choosing one puts
 * it on that screen and pins it there, so automatic switching leaves it alone.
 */
export function FeedPicker(props: FeedPickerProps) {
  const { slot, anchor, feeds, follows, assignment, pinned, onClose } = props;
  const n = screenNumber(slot);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  // Snapshot the order when opened, so rows don't jump under the pointer as scores move.
  const [order] = useState(() => {
    return feeds
      .filter((f) => f.status === 'live')
      .map((f) => ({ id: f.id, mine: isEligible(f, follows), score: f.intensity?.score ?? -1 }))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || b.score - a.score);
  });
  const byId = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);
  const rows = order.flatMap((o) => {
    const f = byId.get(o.id);
    return f && f.status === 'live' ? [{ feed: f, mine: o.mine }] : [];
  });
  const where = useMemo(() => {
    const m = new Map<string, SlotId>();
    for (const [s, f] of Object.entries(assignment)) if (f) m.set(f.id, s as SlotId);
    return m;
  }, [assignment]);
  const currentId = assignment[slot]?.id;

  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, innerWidth - WIDTH - 8));
      const below = innerHeight - r.bottom - GAP - 8;
      const above = r.top - GAP - 8;
      setPos(
        below >= 240 || below >= above
          ? { left, top: r.bottom + GAP, maxHeight: below }
          : { left, bottom: innerHeight - r.top + GAP, maxHeight: above },
      );
    };
    place();
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    return () => {
      removeEventListener('resize', place);
      removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  // Focus the current feed (or the first option) on open; close on outside click.
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.contains(t) && !anchor.contains(t)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    onClose();
    anchor.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation(); // keep the stage's screen keybinds out of the menu
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    } else if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && currentId) {
      e.preventDefault();
      props.onPin(slot, !pinned);
    }
  };

  const choose = (feedId: string) => {
    if (feedId === currentId) {
      if (!pinned) props.onPin(slot, true);
    } else props.onChoose(slot, feedId);
    close();
  };

  let lastMine: boolean | null = null;
  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={`Choose the feed on screen ${n}`}
      style={pos ? { left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: WIDTH } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className={styles.head}>
        <span className={styles.heading}>
          <span className={`${styles.num} mono`}>{n}</span> Screen {n}
          {slot === 'main' && <span className={styles.faint}>· main</span>}
        </span>
        {currentId && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={pinned}
            className={`${styles.pin} ${pinned ? styles.pinOn : ''}`}
            onClick={() => props.onPin(slot, !pinned)}
            title={pinned ? 'Unpin: let automatic switching change this screen (P)' : 'Pin: keep this feed here (P)'}
          >
            {pinned ? <Pin size={14} strokeWidth={2.4} /> : <PinOff size={14} />}
            {pinned ? 'Pinned' : 'Pin'}
          </button>
        )}
      </div>
      <p className={styles.hint}>Pick a feed to show here. It’s pinned so it won’t switch away.</p>
      <div className={styles.list}>
        {rows.length === 0 && <p className={styles.empty}>No live feeds right now.</p>}
        {rows.map(({ feed: f, mine }) => {
          const header =
            lastMine !== mine ? (
              <div key={`h-${mine}`} className={styles.group} role="presentation">
                {mine ? 'Your sports' : 'Other live sports'}
              </div>
            ) : null;
          lastMine = mine;
          const on = where.get(f.id);
          const current = f.id === currentId;
          const score = f.intensity ? Math.round(f.intensity.score) : null;
          return [
            header,
            <button
              key={f.id}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              className={`${styles.item} ${current ? styles.current : ''}`}
              onClick={() => choose(f.id)}
              title={on && !current ? `Swaps with screen ${n}` : undefined}
            >
              <SportIcon sportId={f.sportId} size={14} strokeWidth={2.1} className={styles.sport} />
              <span className={styles.label}>
                <span className={styles.name}>{f.event.title}</span>
                {f.event.subtitle && <span className={styles.sub}>{f.event.subtitle}</span>}
              </span>
              {on && !current && (
                <span className={`${styles.on} mono`} aria-label={`on screen ${screenNumber(on)}`}>
                  {screenNumber(on)}
                </span>
              )}
              <span className={`${styles.score} mono`}>{score ?? '–'}</span>
              <span className={styles.check} aria-hidden>
                {current && <Check size={14} strokeWidth={2.6} />}
              </span>
            </button>,
          ];
        })}
      </div>
    </div>,
    document.body,
  );
}

