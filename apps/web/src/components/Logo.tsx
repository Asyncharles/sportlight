import primary from '../../../../logos/sportlight-primary.svg';
import reversed from '../../../../logos/sportlight-reversed.svg';
import styles from './Logo.module.scss';

// Visible content box of the supplied 628×160 logo artwork (it carries generous padding).
const ART = { w: 628, h: 160, x0: 20, y0: 42, x1: 596, y1: 134 };

/**
 * Wordmark sized by its visible height: primary on light surfaces, reversed on dark — switched in
 * CSS by theme so there is no flash on theme change.
 */
export function Logo({ height = 22, className }: { height?: number; className?: string }) {
  const scale = height / (ART.y1 - ART.y0);
  const imgW = ART.w * scale;
  const imgH = ART.h * scale;
  const style = { width: imgW, height: imgH, left: -ART.x0 * scale, top: -ART.y0 * scale };
  return (
    <span
      className={`${styles.logo} ${className ?? ''}`}
      style={{ height, width: (ART.x1 - ART.x0) * scale }}
      role="img"
      aria-label="Sportlight"
    >
      <img className={styles.light} src={primary} alt="" style={style} draggable={false} />
      <img className={styles.dark} src={reversed} alt="" style={style} draggable={false} />
    </span>
  );
}

/** The two-pill symbol, drawn inline so it follows the theme. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={(size * 70) / 120} viewBox="0 0 120 70" aria-hidden>
      <rect x="30" y="0" width="90" height="30" rx="15" fill="currentColor" />
      <rect x="0" y="40" width="90" height="30" rx="15" fill="var(--sl-lime)" />
    </svg>
  );
}
