/**
 * The star a primary Bot carries.
 *
 * It sits on the avatar, not in the text, so the row stays readable at the 300px section width and
 * the same mark works in the chat list, the conversation header and the details panel. The status
 * dot owns the top-right corner, so the star takes the bottom-left.
 */
export function PrimaryStar({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <span className={`primary-star${className ? ` ${className}` : ''}`} role="img" aria-label="Primary Bot" title="Primary Bot" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
        <path d="M12 2.6l2.9 6.1 6.7 1-4.8 4.7 1.1 6.6-5.9-3.1-5.9 3.1 1.1-6.6L2.4 9.7l6.7-1z" />
      </svg>
    </span>
  );
}
