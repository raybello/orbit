export interface TabFit { visible: number[]; overflow: number[] }

/**
 * Which tabs stay in a bar `available` px wide and which move to a "More" menu `moreWidth` px wide.
 * Tabs keep their order; the active tab is always visible, taking the place of the last tab that
 * fit before it. Indexes refer to `widths`.
 */
export function fitTabs(widths: readonly number[], available: number, moreWidth: number, active: number): TabFit {
  const all = widths.map((_, i) => i);
  if (widths.reduce((a, w) => a + w, 0) <= available) return { visible: all, overflow: [] };
  const budget = available - moreWidth;
  const visible: number[] = [];
  let used = 0;
  for (const i of all) {
    if (used + widths[i] > budget) break;
    visible.push(i);
    used += widths[i];
  }
  if (active >= 0 && active < widths.length && !visible.includes(active)) {
    while (visible.length && used + widths[active] > budget) used -= widths[visible.pop()!];
    visible.push(active);
  }
  return { visible, overflow: all.filter((i) => !visible.includes(i)) };
}
