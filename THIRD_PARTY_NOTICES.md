# Third-Party Notices

Shadow Assistant is licensed under the MIT License (see [LICENSE](LICENSE)).
It includes or is planned to include material from the third-party projects
listed below. Each is used under the terms of its own license, reproduced here.

Dependencies installed through npm or pip are covered by their own package
metadata and are not listed individually.

---

## Jarvis

- Source: https://github.com/adewaskar/jarvis
- License: MIT
- Version used: commit `1c4016a` (2026-08-05)
- Usage: Parts of the user interface (milestone T3) are adapted from this
  project. Each adapted file starts with a header comment that names its
  origin and refers to this notice:
  - `ui/src/scene/Core.tsx` — reactor ring shader (from `src/scene/Core.tsx`)
  - `ui/src/scene/Particles.tsx` — particle shell (from `src/scene/Particles.tsx`)
  - `ui/src/scene/Scene.tsx`, `ui/src/scene/drive.ts` — canvas, per-frame rig
    and the shared drive object (from `src/scene/Scene.tsx`)
  - `ui/src/scene/Effects.tsx` — postprocessing chain (from `src/scene/Scene.tsx`)
  - `ui/src/scene/phaseStyle.ts` — phase colours and spin rates (from
    `src/store.ts` and `src/scene/Scene.tsx`)
  - `ui/src/platform/web.ts` — microphone/output level metering (from
    `src/lib/audio.ts`)
  - `ui/src/index.css` — palette, accent variable, scanline overlay, status
    dot (from `src/index.css`)

  Not taken: the wake word (Picovoice), Web Speech API speech recognition and
  synthesis, voice activity detection, the Claude bridge, hand tracking,
  camera, music, panels and orbit images.

```
MIT License

Copyright (c) 2026 Aditya Dewaskar

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
