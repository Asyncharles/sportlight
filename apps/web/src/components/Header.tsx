import { Link, NavLink, useMatch } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Box, Check, ChevronDown, Columns2, Grid2x2, Lock, LockOpen, PanelLeft, RectangleHorizontal, Settings, SlidersHorizontal, Trophy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNow } from '../lib/hooks';
import { switchView } from '../lib/view-transition';
import { useLive } from '../lib/live-client';
import { useLiveUi } from '../lib/live-ui';
import { useBestUi } from '../lib/best-ui';
import { BestFilterDialog } from './BestFilterDialog';
import { formatClock } from '../lib/format';
import { usePreferences, type LayoutId } from '../lib/preferences';
import { Logo } from './Logo';
import { VoiceControl } from '../features/live/VoiceControl';
import styles from './Header.module.scss';

export function Header() {
  const onAdmin = useMatch({ path: '/admin/*' });
  if (onAdmin) {
    return (
      <header className={styles.header}>
        <div className={styles.left}>
          <Link to="/" className={styles.brand} aria-label="Sportlight home">
            <Logo height={24} />
          </Link>
          <Link to="/live" className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden />
            <span>Back to live</span>
          </Link>
        </div>
      </header>
    );
  }
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Link to="/" className={styles.brand} aria-label="Sportlight home">
          <Logo height={24} />
        </Link>
        <LiveIndicator />
        <BestOfTodayLink />
      </div>
      <nav className={styles.right} aria-label="Main">
        <NavLink to="/admin" className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`} aria-label="Admin dashboard" title="Admin dashboard"><Grid2x2 size={18} /><span>Admin</span></NavLink>
        <BestFilters />
        <ViewSelector />
        <LockToggle />
        <HeaderVoice />
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.iconLink} ${isActive ? styles.active : ''}`}
          aria-label="Settings"
          data-tour="settings"
        >
          <Settings size={18} />
        </NavLink>
      </nav>
    </header>
  );
}

/** Voice commands act on the live windows, so the mic only shows on the live page. */
function HeaderVoice() {
  const onLive = useMatch({ path: '/live', end: true });
  return onLive ? <VoiceControl /> : null;
}

type ViewId = LayoutId | '3d';
const VIEWS: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  { id: 'theatre', label: 'Theatre', icon: <RectangleHorizontal size={16} /> },
  { id: 'classic', label: 'Classic', icon: <Columns2 size={16} /> },
  { id: 'quad', label: 'Quad', icon: <Grid2x2 size={16} /> },
  { id: 'table', label: 'Details', icon: <PanelLeft size={16} /> },
  { id: '3d', label: '3D', icon: <Box size={16} /> },
];

/** View dropdown for the live page; 3D is the spatial room. */
function ViewSelector() {
  const onLive = useMatch({ path: '/live', end: true });
  const { prefs, updateLive } = usePreferences();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!onLive) return null;
  const currentId: ViewId = prefs.live.beta3d ? '3d' : prefs.live.layout;
  const current = VIEWS.find((v) => v.id === currentId) ?? VIEWS[0]!;
  return (
    <div className={styles.viewMenu} ref={ref} data-tour="view">
      <button
        type="button"
        className={`${styles.viewButton} ${open ? styles.active : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`View: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current.icon}
        <span className={styles.viewLabel}>{current.label}</span>
        <ChevronDown size={14} className={styles.chevron} />
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="View">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              aria-checked={v.id === currentId}
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                if (v.id === currentId) return;
                switchView(() =>
                  updateLive(v.id === '3d' ? { beta3d: true } : { beta3d: false, layout: v.id }),
                );
              }}
            >
              {v.icon}
              <span>{v.label}</span>
              {v.id === currentId && <Check size={15} className={styles.check} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Best of Today's filter button (opens the filter dialog), shown in the header on that page. */
function BestFilters() {
  const onBest = useMatch({ path: '/best', end: true });
  const { sports } = useBestUi();
  const [open, setOpen] = useState(false);
  if (!onBest) return null;
  const active = sports !== null;
  return (
    <>
      <button
        type="button"
        className={`${styles.filterButton} ${active ? styles.filterActive : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal size={16} aria-hidden />
        <span>Filter</span>
        {active && <span className={`${styles.filterCount} mono`}>{sports.length}</span>}
      </button>
      <BestFilterDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * Freezes the live windows: no automatic replacements or swaps while on. Feeds that end still
 * leave (there's nothing to show), and clicking a feed still promotes it.
 */
function LockToggle() {
  const onLive = useMatch({ path: '/live', end: true });
  const { locked, toggleLocked } = useLiveUi();
  if (!onLive) return null;
  return (
    <button
      type="button"
      className={`${styles.lock} ${locked ? styles.locked : ''}`}
      data-tour="lock"
      onClick={toggleLocked}
      aria-pressed={locked}
      aria-label={locked ? 'Unlock views (automatic switching resumes)' : 'Lock current views'}
      title={locked ? 'Views locked — press L to unlock' : 'Lock current views (L)'}
    >
      <span className={styles.lockIcon} aria-hidden>
        {locked ? <Lock size={16} strokeWidth={2.25} /> : <LockOpen size={16} />}
      </span>
      <span className={styles.lockLabel}>{locked ? 'Locked' : 'Lock'}</span>
    </button>
  );
}

function LiveIndicator() {
  const { status, ready, clockOffsetMs } = useLive();
  const now = useNow(1000);
  const onBest = useMatch({ path: '/best/*' });
  const online = status === 'open';
  if (onBest) return null;
  return (
    <NavLink to="/live" end className={({ isActive }) => `${styles.live} ${isActive ? styles.active : ''}`}>
      <span className={`${styles.dot} ${online ? styles.dotLive : styles.dotOff}`} aria-hidden />
      <span>{online ? 'Live' : ready ? 'Reconnecting…' : 'Connecting…'}</span>
      <span className={`${styles.clock} mono`} aria-hidden>
        {formatClock(now + clockOffsetMs)}
      </span>
      <span className="sr-only" role="status">
        {online ? '' : 'Connection lost. Reconnecting.'}
      </span>
    </NavLink>
  );
}

/** Link to Best of Today; becomes "Back to live" while on the highlights pages. */
function BestOfTodayLink() {
  const onBest = useMatch({ path: '/best/*' });
  if (onBest) {
    return (
      <Link to="/live" className={styles.backLink}>
        <ArrowLeft size={16} aria-hidden />
        <span>Back to live</span>
      </Link>
    );
  }
  return (
    <Link to="/best" className={styles.navLink} aria-label="Best of today" data-tour="best">
      <Trophy size={16} aria-hidden />
      <span>Best of today</span>
      <ArrowRight size={16} aria-hidden />
    </Link>
  );
}
