# Home Heat Map artwork

Created using the built-in image generation tool. The mark combines a house,
room divisions, sensor dots and blue-to-coral heat contours. It represents the
project's temperature, humidity and wireless signal maps; it does not depict an
actual home. No private floor plans were used as references.

## Files

- `icon-master.png`: original transparent square artwork.
- `logo-master.png`: original transparent horizontal wordmark.
- `banner-master.png`: wordmark on an opaque ivory background, readable in either GitHub theme.
- `readme-banner.png`: 1000×400 README export.
- Root `icon.png`: 128×128 HA store icon.
- Root `logo.png`: 250×100 HA store logo.
- `web/brand-icon.png`: 192×192 app-header image.
- `web/favicon.png`: 32×32 browser icon.

The root PNG filenames and export sizes follow the
[HA presentation guidance](https://developers.home-assistant.io/docs/apps/presentation/).

## Final prompt set

### Icon (new image)

Use case: logo-brand. Create one polished square app icon for the open-source project Home Heat Map, which visualizes temperature, humidity and wireless signal on home floor plans. No text. A bold simple house silhouette with softly rounded corners, containing an abstract floor plan of three or four rooms divided by clean pale negative-space walls. Rich smooth heatmap colour flowing from cool teal/blue through green to warm amber/coral across the rooms; tiny subtle sensor dot only if it remains readable. Modern restrained flat graphic identity, crisp edges, no 3D, no mockup, no shadows, no flame or thermometer, no Home Assistant logo. Centered mark fills about 85% of square. Truly transparent background. Strong readable silhouette at 32px. This is the final icon artwork, a single design, not a presentation board.

### Wordmark (icon as reference)

Use case: logo-brand. Create a horizontal logo lockup for Home Heat Map using the supplied house icon as the exact visual identity reference. Preserve its navy house outline, pale floorplan dividers and blue/teal/green/amber/coral heat contours. Place that icon on the left, occupying one third of the width. To the right put precisely 'Home' on the first line and 'Heat Map' on the second line, generous clean modern rounded sans-serif, bold, very legible, deep navy matching the icon. No other text or slogan. Transparent background, no shadows, no panels or mockups. Wide 5:2 composition with tightly balanced icon and typography, generous safe outer margins. Final usable app-store logo, one design only.

### README banner (wordmark as reference)

Produce a finished README banner using this exact logo design and text Home Heat Map. Keep house icon and navy wordmark layout intact. Replace the transparent background with one solid opaque very pale warm ivory #f5f6f2 rectangle covering the ENTIRE canvas, edge to edge. Clean pristine smooth typography edges. Wide 5:2 image. No transparency at all, no extra text, no drop shadow, no border. The purpose is a clean light logo panel that stays legible on both light and dark GitHub pages.

## Re-export

Run from the repository root with ImageMagick installed:

```sh
magick assets/branding/icon-master.png -resize 128x128 -strip icon.png
magick assets/branding/logo-master.png -resize 250x100 -strip logo.png
magick assets/branding/banner-master.png -resize 1000x400 -strip assets/branding/readme-banner.png
magick assets/branding/icon-master.png -resize 192x192 -strip web/brand-icon.png
magick assets/branding/icon-master.png -resize 32x32 -strip web/favicon.png
```
