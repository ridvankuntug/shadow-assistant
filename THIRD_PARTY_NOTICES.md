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

---

## Piper voice models (tts-svc)

The text-to-speech service downloads Piper voice models at runtime into its
voice directory (`TTS_VOICE_DIR`, the `/voices` volume in Docker). The models
are **not** part of this repository or of the tts-svc image; each download is
pinned to a repository commit and verified against a pinned SHA-256
(`services/tts-svc/tts_svc/voices.py`). Each model keeps its own license, as
stated in its `MODEL_CARD`. Generated audio is played locally and not
redistributed.

Checked 2026-10-28: the official Piper voice repository
(`rhasspy/piper-voices`) contains one Turkish voice, `tr_TR-dfki-medium`.
The two other Turkish voices in Piper's voice list (`fahrettin`, `fettah`) are
only published in a third-party mirror (k2-fsa / sherpa-onnx packaging) and are
taken from there.

| Voice | Quality | Source | License |
|---|---|---|---|
| `tr_TR-dfki-medium` (default) | medium | https://huggingface.co/rhasspy/piper-voices/tree/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/tr/tr_TR/dfki/medium | **CC BY-NC-SA 4.0** — https://creativecommons.org/licenses/by-nc-sa/4.0/ (dataset: MaryTTS `dfki-ot-data`, https://github.com/marytts/dfki-ot-data/) |
| `tr_TR-fahrettin-medium` | medium | https://huggingface.co/csukuangfj/vits-piper-tr_TR-fahrettin-medium/tree/ec73b891c2f4f9b14b1f14dab62b90ea0eb983ad | CC0 per its MODEL_CARD (dataset: https://github.com/NabuCasa/voice-datasets) |
| `tr_TR-fettah-medium` | medium | https://huggingface.co/csukuangfj/vits-piper-tr_TR-fettah-medium/tree/2ebce1b57d884634c3b349670a3971f0ec9440f1 | CC0 per its MODEL_CARD (dataset: https://github.com/NabuCasa/voice-datasets) |

All three are fine-tuned from Piper's U.S. English `lessac` (medium) voice, as
stated in their model cards.

**Non-commercial voice.** `tr_TR-dfki-medium` is licensed CC BY-NC-SA 4.0: it
may be used for this personal, non-commercial assistant, but not commercially.
It stays the default because it is the only Turkish voice with verifiable
upstream provenance. For any commercial use, switch `TTS_VOICE` to one of the
CC0 voices (whose license statement comes from the third-party mirror's model
card) and do not offer `dfki`. Attribution for `dfki`: "dfki (Turkish) Piper
voice, rhasspy/piper-voices, trained on MaryTTS dfki-ot-data, CC BY-NC-SA 4.0".
