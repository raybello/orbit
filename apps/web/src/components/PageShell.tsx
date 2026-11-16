import type { ReactNode } from 'react';

interface PageShellProps {
  title: string;
  /** Beside the title, muted: a count or a one-line description. */
  meta?: ReactNode;
  /** Right side of the header: the page's own controls. */
  actions?: ReactNode;
  /** The body draws its own edge-to-edge panes (Skills' list and detail) instead of taking the inset. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The frame every top-level view sits in: a header row of one height with the title, and a body
 * with one inset. Views own what is inside the body; the spacing around it lives in page.css.
 */
export function PageShell({ title, meta, actions, flush = false, className, children }: PageShellProps) {
  return (
    <section className={`page${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="page__header">
        <div className="page__heading">
          <h1 className="page__title">{title}</h1>
          {meta !== undefined && <span className="page__meta">{meta}</span>}
        </div>
        {actions && <div className="page__actions">{actions}</div>}
      </header>
      <div className={`page__body${flush ? ' page__body--flush' : ''}`}>{children}</div>
    </section>
  );
}
