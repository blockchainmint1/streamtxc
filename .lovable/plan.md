## What's happening

The header markup is identical on every page (same `Header` component, same `max-w-7xl` container, same active-link classes — `px-3 py-1.5` is preserved when active, only the colour changes). So the header itself isn't actually re-laying-out.

What IS changing is the page underneath:

- `/about` is short and fits in the viewport → **no vertical scrollbar**.
- `/upload` is tall → **vertical scrollbar appears**.

A scrollbar is ~15px wide on Windows/Linux Chrome. When it appears, the viewport's available width shrinks by 15px, the centered `mx-auto max-w-7xl` container shifts left by ~7-8px, and the logo + nav appear to "jump" sideways. This is the classic source of the "tiny shift between pages" symptom.

## Fix

One line in `src/styles.css`, applied globally to `html`:

```css
html {
  scrollbar-gutter: stable;
}
```

This reserves space for the scrollbar even when the page doesn't need to scroll, so the content area is the same width on every route. The header (and every centered container in the app) will stop shifting.

Trade-off: short pages will show a thin empty gutter on the right where the scrollbar would go. That's the standard cost of stable layout and is invisible on macOS/iOS where scrollbars are overlaid. If you'd rather hide it entirely on short pages, the alternative is `overflow-y: scroll` on `html` which always shows a (greyed-out) scrollbar — uglier but no gutter.

## Files to change

- `src/styles.css` — add the `html { scrollbar-gutter: stable; }` rule near the top-level resets.

That's it. No component changes needed.
