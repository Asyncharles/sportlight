import primary from '../../../../logos/sportlight-primary.svg?raw';
import styles from './Logo.module.scss';

// Trusted local artwork, cropped to its visible bounds and coloured by the app tokens.
const artwork = primary
  .replace('viewBox="0 0 628 160"', 'viewBox="20 42 576 92"')
  .replaceAll('#171917', 'currentColor')
  .replaceAll('#C5FF00', 'var(--accent)');

/**
 * Original wordmark sized by its visible height, with the selected accent and appearance.
 */
export function Logo({ height = 22, className }: { height?: number; className?: string }) {
  return (
    <span
      className={`${styles.logo} ${className ?? ''}`}
      style={{ height, width: (576 / 92) * height }}
      role="img"
      aria-label="Sportlight"
      dangerouslySetInnerHTML={{ __html: artwork }}
    />
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
