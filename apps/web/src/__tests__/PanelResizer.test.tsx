import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { COLLAPSE_SLOP, PanelResizer, resizeStep, usePanelWidth, type PanelBounds } from '../components/PanelResizer';

const b: PanelBounds = { min: 220, max: 480, initial: 300 };

describe('resizeStep', () => {
  it('a left panel (handle on its right edge) grows as the pointer moves right', () => {
    expect(resizeStep(300, 40, 'right', b)).toBe(340);
  });
  it('a right panel (handle on its left edge) grows as the pointer moves left', () => {
    expect(resizeStep(300, -40, 'left', b)).toBe(340);
  });
  it('stays inside the bounds', () => {
    expect(resizeStep(300, 900, 'right', b)).toBe(480);
    expect(resizeStep(300, -100, 'right', b)).toBe(220);
  });
  it('collapses only once the drag goes well past the minimum', () => {
    expect(resizeStep(300, -(300 - 220 + COLLAPSE_SLOP - 1), 'right', b)).toBe(220);
    expect(resizeStep(300, -(300 - 220 + COLLAPSE_SLOP + 1), 'right', b)).toBe('collapse');
  });
});

function Harness({ onCollapse }: { onCollapse: () => void }) {
  const [width, setWidth] = usePanelWidth('test.width', b);
  const [open, setOpen] = useState(true);
  return open ? (
    <div>
      <span data-testid="w">{width}</span>
      <PanelResizer edge="right" width={width} bounds={b} onWidth={setWidth} onCollapse={() => { setOpen(false); onCollapse(); }} label="Resize" />
    </div>
  ) : <span>collapsed</span>;
}

describe('PanelResizer', () => {
  // jsdom has no pointer capture; the browser does, and the live check covers it.
  Object.assign(HTMLElement.prototype, { setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => true });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it('dragging resizes, and the width is kept for next time', () => {
    render(<Harness onCollapse={() => {}} />);
    const handle = screen.getByRole('separator', { name: 'Resize' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 360, pointerId: 1 });
    expect(screen.getByTestId('w').textContent).toBe('360');
    expect(localStorage.getItem('test.width')).toBeNull();
    fireEvent.pointerUp(handle, { clientX: 360, pointerId: 1 });
    expect(localStorage.getItem('test.width')).toBe('360');
  });

  it('dragging far past the minimum collapses the panel and remembers the width it had', () => {
    const onCollapse = vi.fn();
    render(<Harness onCollapse={onCollapse} />);
    const handle = screen.getByRole('separator', { name: 'Resize' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 0, pointerId: 1 });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(screen.getByText('collapsed')).toBeTruthy();
    expect(localStorage.getItem('test.width')).toBe('300');
  });

  it('the arrow keys resize it and double-click resets it', () => {
    render(<Harness onCollapse={() => {}} />);
    const handle = screen.getByRole('separator', { name: 'Resize' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('316');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(screen.getByTestId('w').textContent).toBe('480');
    fireEvent.doubleClick(handle);
    expect(screen.getByTestId('w').textContent).toBe('300');
    expect(localStorage.getItem('test.width')).toBe('300');
  });

  it('a saved width outside the bounds falls back to the default', () => {
    localStorage.setItem('test.width', '9000');
    render(<Harness onCollapse={() => {}} />);
    expect(screen.getByTestId('w').textContent).toBe('300');
  });
});
