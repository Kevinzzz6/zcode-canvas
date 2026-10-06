# Third-party notices

## zcode-fox-widget

The desktop pet's assets in `pets/fox/` come unmodified from
[zcode-fox-widget](https://github.com/pigeon189/zcode-fox-widget) `assets/`:

- `fox.png` is that project's `GLM.png` (the fox maid, added by pigeon189), renamed.
- `rua.gif`, `Ya1.mp3`, `Ya2.mp3`, `D1.mp3` and `D2.mp3` are carried over by zcode-fox-widget from
  its upstream [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
  by MeteorNOX, via [zcode-whale-widget](https://github.com/nb10yyds/zcode-whale-widget) by nb10yyds.

`src/runtime/pet.ts` re-implements that widget's speech bubble geometry, type sizes, press
animation, quarter-snap dragging and press/release sound timing, and `src/runtime/pet-quotes.ts`
carries a selection of its fox quote pack (`QUOTE_PACK_FOX`) with its weights. The balance, quota and billing
features are not included.

```
MIT License

Copyright (c) 2026 MeteorNOX
Copyright (c) 2026 pigeon189 (ZCode Fox Widget / zcode-fox-widget)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## zcode-eye-care

The `eye-care` theme palette (`themes/eye-care/theme.json`, light mode) is adapted from
[zcode-eye-care](https://github.com/VoodooB0Ys/zcode-eye-care) `themes/light.css`.

MIT License — Copyright (c) 2026 xhwx

## dsh-theme-endfield

The `endfield` and `endfield-wuling` themes are adapted from
[dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield): the palette and its
contrast rules (`docs/design-language.md`), the square-corner treatment, and the boot-plate
wordmark typesetting. The contour wallpapers are rendered by `scripts/build-endfield.mjs` from
its terrain kernel, vendored verbatim in `scripts/endfield/contour-kernel.js`.

MIT License — Copyright (c) 2026 ymh0000123

"Arknights: Endfield" and "ENDFIELD" belong to their respective owners; these themes are
unofficial fan work and ship no official logo or artwork.

## NieR:Automata / YoRHa

The `yorha` theme is unofficial fan work inspired by NieR:Automata. It is not affiliated with,
endorsed by, or sponsored by SQUARE ENIX CO., LTD. or PlatinumGames Inc.

**The YoRHa emblem is not covered by this project's MIT license.** `themes/yorha/emblem.svg` is
a vector trace of the YoRHa emblem from NieR:Automata, and the same emblem is embedded in
`themes/yorha/logo.svg`, `themes/yorha/wallpaper-dark.svg` and `themes/yorha/wallpaper-light.svg`.
NieR:Automata, YoRHa, the YoRHa emblem and the slogan "For the Glory of Mankind" are trademarks
or copyrighted works of SQUARE ENIX CO., LTD. They are included only for non-commercial fan use;
no rights to them are granted, and they may not be reused under the MIT license. The theme's
SPDX expression is `MIT AND LicenseRef-YoRHa-Emblem` for this reason.

Everything else in the theme is original and MIT: the palette and layout, which were measured
from and drawn after in-game screenshots (no screenshot or game file is included); the
wallpaper patterns; and the YoRHa wordmark, redrawn as geometric strokes rather than copied
from a font or game file.

Rights holders who want the emblem removed can open an issue. Running
`node scripts/build-yorha.mjs --no-emblem` and deleting `themes/yorha/emblem.svg` removes it
from every file; the rest of the theme keeps working unchanged.

© SQUARE ENIX. NieR:Automata is developed by PlatinumGames Inc.
