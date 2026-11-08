import { Link, NavLink, useMatch } from 'react-router-dom';
import { Activity, ArrowLeft, ArrowRight, Box, Check, Clapperboard, ChevronDown, Columns2, Grid2x2, Lock, LockOpen, MoreHorizontal, PanelLeft, PanelTop, Rows2, Rows3, RectangleHorizontal, Settings, SlidersHorizontal, Trophy } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIsPhone, useNow } from '../lib/hooks';
import { switchView } from '../lib/view-transition';
import { useLive } from '../lib/live-client';
import { activeLayout, useLiveUi } from '../lib/live-ui';
import { useBestUi } from '../lib/best-ui';
import { BestFilterDialog } from './BestFilterDialog';
import { formatClock } from '../lib/format';
import { usePreferences, type LayoutId, type PhoneLayoutId } from '../lib/preferences';
import { Logo, LogoMark } from './Logo';
import { VoiceControl } from '../features/live/VoiceControl';
import styles from './Header.module.scss';

export function Header() {
  const onAdmin = useMatch({ path: '/admin/*' });
  if (onAdmin) {
    return (
      <header className={styles.header}>
        <div className={styles.left}>
          <Brand />
          <Link to="/live" className={styles.backLink}>
            <ArrowLeft size={16} aria-hidden />
            <span>Back to live</span>
          </Link>
        </div>
        <nav className={styles.right} aria-label="Admin">
          <NavLink to="/admin" end className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
            <Activity size={18} aria-hidden />
            <span className={styles.collapsible}>Operations</span>
          </NavLink>
          <NavLink to="/admin/shorts" className={({ isActive }) => `${styles.navLink} ${isActive ? styles.active : ''}`}>
            <Clapperboard size={18} aria-hidden />
            <span className={styles.collapsible}>Shorts</span>
          </NavLink>
        </nav>
      </header>
    );
  }
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <Brand />
        <LiveIndicator />
        <BestOfTodayLink />
      </div>
      <nav className={styles.right} aria-label="Main">
        <NavLink to="/admin" className={({ isActive }) => `${styles.navLink} ${styles.desktopOnly} ${isActive ? styles.active : ''}`} aria-label="Admin dashboard" title="Admin dashboard"><Grid2x2 size={18} /><span>Admin</span></NavLink>
        <BestFilters />
        <ViewSelector />
        <LockToggle />
        <HeaderVoice />
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.iconLink} ${styles.desktopOnly} ${isActive ? styles.active : ''}`}
          aria-label="Settings"
          data-tour="settings"
        >
          <Settings size={18} />
        </NavLink>
        <MoreMenu />
      </nav>
    </header>
  );
}

function Brand() {
  return (
    <Link to="/" className={styles.brand} aria-label="Sportlight home">
      <Logo height={24} className={styles.brandFull} />
      <span className={styles.brandMark}>
        <LogoMark size={26} />
      </span>
    </Link>
  );
}

/** Use a popup menu that closes on outside press or Escape. */
function usePopup() {
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
  return { open, setOpen, ref };
}

/** Phones: Admin and Settings fold into one overflow menu to keep the bar on one line. */
function MoreMenu() {
  const { open, setOpen, ref } = usePopup();
  return (
    <div className={`${styles.viewMenu} ${styles.phoneOnly}`} ref={ref}>
      <button
        type="button"
        className={`${styles.iconButton} ${open ? styles.active : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="More">
          <Link to="/settings" role="menuitem" className={styles.menuItem} onClick={() => setOpen(false)}>
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <Link to="/admin" role="menuitem" className={styles.menuItem} onClick={() => setOpen(false)}>
            <Grid2x2 size={16} />
            <span>Admin</span>
          </Link>
        </div>
      )}
    </div>
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

/** Phones get their own views, each sized to fit the screen without scrolling. */
const PHONE_VIEWS: Array<{ id: PhoneLayoutId; label: string; icon: ReactNode }> = [
  { id: 'phone-table', label: 'Details', icon: <PanelTop size={16} /> },
  { id: 'duo', label: 'Duo', icon: <Rows2 size={16} /> },
  { id: 'trio', label: 'Trio', icon: <Rows3 size={16} /> },
];

/** View dropdown for the live page; 3D is the spatial room. */
function ViewSelector() {
  const onLive = useMatch({ path: '/live', end: true });
  const phone = useIsPhone();
  const { prefs, updateLive } = usePreferences();
  const { open, setOpen, ref } = usePopup();

  if (!onLive) return null;
  const views: Array<{ id: ViewId | PhoneLayoutId; label: string; icon: ReactNode }> = phone ? PHONE_VIEWS : VIEWS;
  const currentId = phone ? activeLayout(prefs.live, true) : prefs.live.beta3d ? '3d' : prefs.live.layout;
  const current = views.find((v) => v.id === currentId) ?? views[0]!;
  const select = (id: ViewId | PhoneLayoutId) => {
    if (phone) updateLive({ phoneLayout: id as PhoneLayoutId });
    else updateLive(id === '3d' ? { beta3d: true } : { beta3d: false, layout: id as LayoutId });
  };
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
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitemradio"
              aria-checked={v.id === currentId}
              className={styles.menuItem}
              onClick={() => {
                setOpen(false);
                if (v.id === currentId) return;
                switchView(() => select(v.id));
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
      <span className={styles.liveLong}>{online ? 'Live' : ready ? 'Reconnecting…' : 'Connecting…'}</span>
      <span className={styles.liveShort} aria-hidden>
        {online ? 'Live' : 'Offline'}
      </span>
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
        <span>
          Back<span className={styles.collapsible}> to live</span>
        </span>
      </Link>
    );
  }
  return (
    <Link to="/best" className={styles.navLink} aria-label="Best of today" data-tour="best">
      <Trophy size={16} aria-hidden />
      <span className={styles.collapsible}>Best of today</span>
      <ArrowRight size={16} aria-hidden className={styles.collapsible} />
    </Link>
  );
}
