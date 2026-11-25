# Issue types: root causes and fixes

Read only the sections for issue types that appear in the report.

## horizontal-overflow / overflowing-element (high)
The page scrolls sideways on small screens. `overflowing-element` names the outermost element that sticks out, which is usually the culprit.

Common causes → fixes:
- Fixed widths (`width: 600px`, Tailwind `w-[600px]`) → `max-width: 100%` / `w-full max-w-[600px]`.
- Flex rows that don't wrap → `flex-wrap: wrap`, or stack on mobile (`flex-col md:flex-row`).
- Flex/grid children with long content refusing to shrink → `min-width: 0` on the child (`min-w-0`).
- Grids with fixed column counts → `grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))` or `grid-cols-1 md:grid-cols-3`.
- Long words, URLs, emails, code → `overflow-wrap: anywhere` (`break-words`) or `word-break: break-all` for hashes.
- Wide tables → wrap in a container with `overflow-x: auto`.
- `100vw` on elements (includes the scrollbar width) → `width: 100%`.
- Images/videos/iframes without limits → `max-width: 100%; height: auto`.
- Negative margins or `translateX` decorations → contain them in a parent with `overflow: hidden` (the parent, not `body`).

Never "fix" this with `overflow-x: hidden` on `html`/`body`. It hides the content and breaks `position: sticky`.

## clipped-text (medium)
A box with `overflow: hidden` cuts off its own text.
- Fixed `height` on a text container → use `min-height` instead.
- Intentional single-line truncation → add `text-overflow: ellipsis; white-space: nowrap` (`truncate`).
- Intentional multi-line truncation → `line-clamp-2` etc.
- Buttons/badges with fixed width → use padding instead of width.

## small-tap-target (medium, touch viewports)
Interactive elements smaller than 24×24px (WCAG 2.2 AA). 44×44 is the comfortable target.
- Icon buttons → `min-width: 44px; min-height: 44px` or padding (`p-2.5` around a 24px icon).
- Links in nav/footers → vertical padding (`py-2`) or `display: inline-block` with padding.
- Checkboxes/radios → enlarge, or make the whole `<label>` the target.
- Keep enough spacing between adjacent targets.

## tiny-text (low)
Text under 12px is hard to read on phones.
- Body text should be ≥16px on mobile; captions/labels ≥12px.
- Watch for `text-xs` (12px) combined with scaling or `em` units that compound.
- Inputs under 16px make iOS Safari zoom on focus. Use 16px for inputs.

## broken-image (high)
- Wrong path (case-sensitive on Linux servers, missing leading `/`, wrong `public/` assumption).
- Framework image components: check configured remote domains (e.g. `images.remotePatterns` in Next.js).
- Always set `alt`; set `width`/`height` or `aspect-ratio` to avoid layout shift.

## js-exception (high) / console-error (medium)
Read the message. Uncaught exceptions often mean part of the page never rendered, so check the screenshot for missing sections. Hydration mismatch warnings mean server and client markup differ (dates, `Math.random`, `window` checks during render).

## failed-request (high for document/script/stylesheet, medium otherwise)
- 404 on JS/CSS → wrong base path or a stale build.
- 404 on fonts → the font isn't loading, so text renders in a fallback font.
- 401/403 on API calls → the page needs data/auth. Check with seed or test data, not real credentials.
- CORS errors → API not allowing the dev origin.

## a11y:* (axe-core)
The `helpUrl` in report.json explains each rule. Most common:
- `color-contrast` → text needs 4.5:1 contrast (3:1 for ≥24px or bold ≥18.66px). Darken text or lighten background.
- `image-alt` → add `alt` (empty `alt=""` for decorative images).
- `label` / `select-name` → every input needs a `<label for>` or `aria-label`.
- `button-name` / `link-name` → icon-only controls need `aria-label`.
- `html-has-lang` → `<html lang="en">`.
- `heading-order` → don't skip heading levels.
- `meta-viewport` → never disable zoom (`user-scalable=no`, `maximum-scale=1`).

## CHANGED vs baseline (info)
Open `<viewport>.diff.png`. Red pixels changed. Ask: did I mean to change this page? Small anti-aliasing noise under ~0.5% is normal; raise `--diff-threshold` if fonts render slightly differently between runs.
