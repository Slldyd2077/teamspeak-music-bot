import { describe, it, expect, vi } from "vitest";
import { ref, nextTick } from "vue";
import { useDecoupledSlider } from "./useDecoupledSlider.js";

/** Minimal stand-in for an <input type="range"> change/input Event. */
function ev(value: number): Event {
  return { target: { value: String(value) } } as unknown as Event;
}

describe("useDecoupledSlider (#111)", () => {
  it("initialises display from the source, falling back when undefined", () => {
    const src = ref<number | undefined>(40);
    const { display } = useDecoupledSlider(() => src.value, () => {});
    expect(display.value).toBe(40);

    const empty = useDecoupledSlider(() => undefined, () => {}, 75);
    expect(empty.display.value).toBe(75);
  });

  it("reflects external source changes into the display when not dragging", async () => {
    const src = ref<number | undefined>(50);
    const { display } = useDecoupledSlider(() => src.value, () => {});
    src.value = 80;
    await nextTick();
    expect(display.value).toBe(80);
  });

  it("tracks @input locally without committing", () => {
    const commit = vi.fn();
    const { display, onInput } = useDecoupledSlider(() => 50, commit);
    onInput(ev(63));
    expect(display.value).toBe(63);
    expect(commit).not.toHaveBeenCalled();
  });

  // THE REGRESSION: this is exactly what the 60fps rAF re-render did — push the
  // (stale) source value back into the binding mid-drag. The guard must ignore
  // it so the thumb stays where the user dragged it.
  it("ignores external source changes WHILE dragging (no snap-back)", async () => {
    const src = ref<number | undefined>(50);
    const { display, onInput } = useDecoupledSlider(() => src.value, () => {});

    onInput(ev(70)); // user starts dragging → display 70
    expect(display.value).toBe(70);

    // Simulate the per-frame re-render re-evaluating the (still-stale) source.
    src.value = 50;
    await nextTick();
    expect(display.value).toBe(70); // stayed put — did NOT snap back to 50
  });

  // Corner case: a range input skips `change` when released back at its start
  // value. onRelease (pointerup/pointercancel/blur) must still end the drag so
  // the slider doesn't freeze against later external updates.
  it("clears dragging on release even when @change never fires", async () => {
    const src = ref<number | undefined>(50);
    const { display, onInput, onRelease } = useDecoupledSlider(() => src.value, () => {});

    onInput(ev(70)); // drag begins
    onInput(ev(50)); // ...dragged back to the start value
    onRelease();     // released — browser emits NO change event here

    src.value = 30; // a later external update
    await nextTick();
    expect(display.value).toBe(30); // slider resumed following the source
  });

  it("commits on @change and resumes following the source afterwards", async () => {
    const commit = vi.fn();
    const src = ref<number | undefined>(50);
    const { display, onInput, onChange } = useDecoupledSlider(() => src.value, commit);

    onInput(ev(70));
    onChange(ev(70)); // release
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(70);
    expect(display.value).toBe(70);

    // After release, external changes flow through again.
    src.value = 35;
    await nextTick();
    expect(display.value).toBe(35);
  });
});
