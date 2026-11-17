import type { CSSProperties } from 'react';

export type IconName =
  | 'apps' | 'arrow_down' | 'chat_filled' | 'check' | 'chev_down' | 'chev_left' | 'chev_right' | 'clock' | 'close'
  | 'composer_plus' | 'copy' | 'edit' | 'file' | 'mic' | 'paperclip' | 'plus' | 'record' | 'save'
  | 'search' | 'share' | 'sidebar' | 'slack' | 'star' | 'voice_a' | 'voice_b'
  // nav rail sections (mask files under public/assets/icons)
  | 'activity' | 'calendar' | 'calls' | 'files_folder' | 'computers' | 'skills' | 'grid'
  // inline extras not in the icon font export
  | 'arrow_up' | 'stop' | 'more' | 'monitor' | 'refresh'
  // inline outline glyphs
  | 'eye' | 'pointer' | 'expand' | 'shrink' | 'panel' | 'emoji' | 'people' | 'bell' | 'bell_off' | 'leave'
  // settings nav
  | 'sliders' | 'palette' | 'key' | 'shield' | 'person';

const INLINE: Partial<Record<IconName, string>> = {
  arrow_up: 'M12 4.5a1 1 0 0 1 .7.3l6 6a1 1 0 0 1-1.4 1.4L13 7.9V19a1 1 0 1 1-2 0V7.9l-4.3 4.3a1 1 0 1 1-1.4-1.4l6-6a1 1 0 0 1 .7-.3Z',
  stop: 'M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z',
  more: 'M5 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z',
  monitor: 'M4.5 4h15A2.5 2.5 0 0 1 22 6.5v9a2.5 2.5 0 0 1-2.5 2.5H13v1.5h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3V18H4.5A2.5 2.5 0 0 1 2 15.5v-9A2.5 2.5 0 0 1 4.5 4Zm0 2a.5.5 0 0 0-.5.5v9c0 .28.22.5.5.5h15a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-15Z',
  refresh: 'M12 4a8 8 0 0 1 7.2 4.5V6a1 1 0 1 1 2 0v5a1 1 0 0 1-1 1h-5a1 1 0 1 1 0-2h2.6A6 6 0 1 0 18 14.4a1 1 0 1 1 1.9.6A8 8 0 1 1 12 4Z',
};

/** Outline glyphs, drawn with a 1.8px round stroke. */
const OUTLINE: Partial<Record<IconName, string>> = {
  chev_left: 'M15 4.5l-7 7.5 7 7.5',
  eye: 'M2.6 12s3.4-6.4 9.4-6.4 9.4 6.4 9.4 6.4-3.4 6.4-9.4 6.4S2.6 12 2.6 12Z M12 9.3a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z',
  pointer: 'M5.4 4.6 10.9 19.4 13.2 13.2 19.4 10.9 5.4 4.6Z',
  expand: 'M14.5 4.5h5v5 M19.5 4.5l-5.8 5.8 M9.5 19.5h-5v-5 M4.5 19.5l5.8-5.8',
  shrink: 'M19.5 9.7h-5.2V4.5 M14.3 9.7l5.4-5.4 M4.5 14.3h5.2v5.2 M9.7 14.3l-5.4 5.4',
  // details-panel toggle: a page with a filled right rail (Teams' panel icon).
  panel: 'M4 5.5h16v13H4z M15.5 5.5v13',
  emoji: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4Z M9 10.2h.01 M15 10.2h.01 M8.6 14a4.4 4.4 0 0 0 6.8 0',
  people: 'M9 11.2a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6Z M2.9 19.6c0-2.9 2.7-4.8 6.1-4.8s6.1 1.9 6.1 4.8 M15.9 5.3a3 3 0 0 1 0 5.6 M17.3 14.9c2.3.4 3.9 1.9 3.9 4.4',
  bell: 'M12 3.6a5.6 5.6 0 0 0-5.6 5.6v4.1l-1.6 2.8h14.4l-1.6-2.8V9.2A5.6 5.6 0 0 0 12 3.6Z M10 19a2 2 0 0 0 4 0',
  bell_off: 'M4 4l16 16 M18.4 13.6V9.2A6.4 6.4 0 0 0 11 2.9 M7.6 7.7A5.6 5.6 0 0 0 6.4 9.2v4.1l-1.6 2.8h11 M10 19a2 2 0 0 0 4 0',
  leave: 'M14 4.2h3.6a2 2 0 0 1 2 2v11.6a2 2 0 0 1-2 2H14 M9.4 8.2 5.6 12l3.8 3.8 M5.6 12h9.2',
  sliders: 'M4.5 7h9 M17.5 7h2 M15.5 5v4 M4.5 17h3 M11.5 17h8 M9.5 15v4',
  palette: 'M12 3.8a8.2 8.2 0 0 0 0 16.4c1.2 0 1.9-.8 1.9-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8h2.1a3.4 3.4 0 0 0 3.4-3.4c0-3.9-3.7-7-8.2-7Z M7.6 11.2h.01 M9.8 7.9h.01 M14.2 7.9h.01 M16.6 11.2h.01',
  key: 'M7.8 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z M11.4 12h8.6 M17.2 12v3 M20 12v2.2',
  shield: 'M12 3.6 5.4 6.1v5.3c0 4.2 2.8 7.6 6.6 9 3.8-1.4 6.6-4.8 6.6-9V6.1L12 3.6Z M9.2 12.1l2 2 3.6-3.8',
  person: 'M12 11.6a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z M4.8 20.2c.6-3.4 3.6-5.6 7.2-5.6s6.6 2.2 7.2 5.6',
};

interface Props { name: IconName; size?: number; opacity?: number; className?: string; style?: CSSProperties; color?: string }

/** Single-color glyph from /assets/icons drawn as a CSS mask so it takes `currentColor`. */
export function Icon({ name, size = 16, opacity, className, style, color }: Props) {
  const inline = INLINE[name];
  if (inline) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ opacity, color, flexShrink: 0, ...style }}>
        <path d={inline} fill="currentColor" />
      </svg>
    );
  }
  const outline = OUTLINE[name];
  if (outline) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ opacity, color, flexShrink: 0, ...style }}>
        <path d={outline} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  const url = `url(/assets/icons/${name}.svg)`;
  // Two sources only: INLINE/OUTLINE above, or a mask file here. A name missing from both renders an
  // empty box with no error, so a new icon needs its SVG under public/assets/icons as well.
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: 'inline-block', flexShrink: 0, width: size, height: size, opacity, color,
        backgroundColor: 'currentColor', WebkitMask: `${url} center / 100% 100% no-repeat`, mask: `${url} center / 100% 100% no-repeat`,
        ...style,
      }}
    />
  );
}
