import { ref, watch, type Ref } from 'vue';

/**
 * A slider whose displayed value is decoupled from its reactive source.
 *
 * Why this exists (#111): the player components run a 60fps requestAnimationFrame
 * loop (progress clock, #107) that re-renders the whole component every ~16ms.
 * Binding a range `<input :value>` straight to a reactive source (the store
 * volume) let Vue re-apply `el.value = source` on every one of those re-renders.
 * Mid-drag the source is still the *old* value, so the native drag position kept
 * getting snapped back — the thumb was effectively un-draggable on desktop and
 * janky on mobile.
 *
 * The fix is to bind `:value` to a LOCAL ref that:
 *  - tracks the native drag synchronously via `@input` (so the bound value always
 *    equals the element's value → Vue never resets it), and
 *  - is committed to the real source only on `@change` (release).
 * External source changes (bot switch, another client) still flow into the
 * display — except while the user is actively dragging, where they must be
 * ignored or they'd fight the drag.
 *
 * @param source  getter for the authoritative value (e.g. () => bot?.volume)
 * @param commit  called with the final value on release (e.g. store.setVolume)
 * @param fallback value to show when the source is undefined (default 75)
 */
export function useDecoupledSlider(
  source: () => number | undefined,
  commit: (value: number) => void,
  fallback = 75
): {
  display: Ref<number>;
  dragging: Ref<boolean>;
  onInput: (e: Event) => void;
  onChange: (e: Event) => void;
  onRelease: () => void;
} {
  const display = ref<number>(source() ?? fallback);
  const dragging = ref(false);

  watch(source, (v) => {
    // Reflect external/store changes — but never while dragging, or the
    // per-frame re-render would yank the thumb away from the user's finger.
    if (!dragging.value && typeof v === 'number') display.value = v;
  });

  function onInput(e: Event): void {
    dragging.value = true;
    display.value = Number((e.target as HTMLInputElement).value);
  }

  function onChange(e: Event): void {
    dragging.value = false;
    const v = Number((e.target as HTMLInputElement).value);
    display.value = v;
    commit(v);
  }

  function onRelease(): void {
    // Safety net for pointerup / pointercancel / blur: a range input does NOT
    // emit `change` if the value is released back at its starting point, which
    // would otherwise leave `dragging` stuck true and freeze the slider against
    // later external updates. Clearing here is idempotent with onChange.
    dragging.value = false;
  }

  return { display, dragging, onInput, onChange, onRelease };
}
