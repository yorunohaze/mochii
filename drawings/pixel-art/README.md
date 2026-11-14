# Mochii pixel-art asset pack

Created 2026-11-14 with the built-in image_gen tool. **32 transparent PNG files**, one drawing per file, in Mochii's cream, peach, mint, lavender and cocoa palette.

Open [index.html](index.html) to browse the artwork with cream, dark or checkerboard backgrounds and 72/128/192 px previews. No server is required.

## Contents

| Asset | Files | Canvas |
| --- | --- | --- |
| Neutral Mochii cat | `cat.png` | 640 × 680 |
| Six weather cats | `moods/sunny.png`, `rainy.png`, `foggy.png`, `cloudy.png`, `stormy.png`, `rainbow.png` | 640 × 880 each |
| App logo | `logo.png` | 512 × 512 |
| Two cats sharing coffee in a park | `together.png` | 1800 × 1080 |
| Explore, Our plans, My space | `navigation/nav-explore.png`, `nav-plans.png`, `nav-space.png` | 192 × 192 each |
| Default MOOD paw | `mood-neutral.png` | 192 × 192 |
| Activity stamps | `activities/coffee.png`, `walk.png`, `cooking.png`, `gym.png`, `groceries.png`, `sauna.png`, `swimming.png`, `movie.png`, `study.png`, `games.png` | 192 × 192 each |
| Standalone mood weather symbols | `weather/sunny.png`, `rainy.png`, `foggy.png`, `cloudy.png`, `stormy.png`, `rainbow.png` | 192 × 192 each |
| Home-screen icon exports | `app-icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | 192, 512, 180 px square |

The default MOOD paw reuses the My space paw drawing. The three app-icon exports derive from the logo. There are 28 distinct illustrations plus these four reusable exports.

## Weather meanings

- Sunny: happy.
- Rainy: sad; the cat wears a yellow raincoat beneath a rain cloud.
- Foggy: uncertain.
- Cloudy: low energy.
- Stormy: overwhelmed.
- Rainbow: hopeful.

## Using the artwork

These are raster PNG assets with alpha transparency, not SVG files. The main drawings use the requested aspect ratios at 3–4× size. Final PNGs were resized with nearest-neighbor sampling and transparent padding to retain pixel edges.

For crisp browser display, use `image-rendering: pixelated;` and preserve each image's aspect ratio. At map size, use a containing box rather than stretching the weather cats into a square.

This is Mochii's official artwork. The app serves copies from `public/icons/` (same file names and folders), and the old SVG art and its generator script have been removed. To change a drawing, replace it here and copy it to the matching path in `public/icons/`. The iPhone and Android home-screen icons in `public/icons/` (`apple-touch-icon.png`, `icon-maskable-*.png`) are flattened onto peach from `app-icons/`, because iOS shows transparent corners as black and Android crops maskable icons to a circle.

The separate avatar and standalone weather files serve different purposes: `moods/` contains full cats; `weather/` contains only the symbols for buttons.

## Generation record and checks

[Generation prompts](generation.json) contains the exact prompt set, including the targeted Foggy and cloud-icon corrections. The base cat was used as a visual reference for all weather cats, the logo and the sign-in illustration. Source paths in that record identify the original generated PNGs on the creator's machine; the delivered assets are self-contained in this folder.

[Asset metadata](assets.json) lists each final filename, dimensions, size and alpha range. All 32 PNGs were decoded and verified to contain transparent background pixels and visible artwork. The generated images were visually inspected, and final icon exports were also inspected at their exported size.

Generated artwork uses the built-in image_gen mode; no API key or CLI fallback was used.
