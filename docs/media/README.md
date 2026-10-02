# Terminal recording

`session.gif` is the terminal client's README demonstration: a real local model
inspecting its serving environment, not a reconstructed UI or scripted answer.

| Capture | Value |
| --- | --- |
| Date | 2026-10-02 |
| Client | 0.94.0, `1f0785d` |
| Service | 1.26.0, `97df158c4` |
| Model | Qwen3.8-27B-UD-Q3_K_XL through llama.cpp |
| Terminal | 112 columns × 44 rows, dark background |
| Playback | Real time, sampled every 300 ms; startup, prompt typing, and exit omitted |

Prompt:

> Good morning. Please evaluate this system to confirm the identity of the local model running on this machine.

## Refreshing

1. Build the current client. Use a fresh workspace and a private daemon through
   the service's public launcher; keep shared sessions and model settings intact.
   Use the real-model test profile to exclude personal policies and ambient tools.
2. Record the real TUI's PTY output as asciicast v2 with `node-pty`, including
   timing and terminal dimensions. Enter the prompt and wait for actual loop
   completion; keep the final answer visible before quitting normally.
3. Review the session, including failed checks and the final answer. Check the
   complete recording for credentials and private material before publication.
   Start the clip with the submitted prompt and initial operations visible.
4. Replay the recorded bytes in xterm.js with DejaVu Sans Mono at 14 px, background
   `#0d1117`, foreground `#d6dde6`, and 14 px padding. Await each terminal write
   before taking Chromium screenshots; capture every 300 ms at device scale 1.
5. Encode the frames with ImageMagick, retaining their timing:

   ```sh
   magick -limit memory 512MiB -limit map 512MiB -limit disk 4GiB \
     -delay 30 frames/frame-*.png -loop 0 -layers Optimize session.gif
   ```

Inspect the encoded GIF's first, middle, and final frames. Preserve authentic
output rather than editing away model mistakes. Keep raw recordings, model
evidence, and temporary render dependencies outside the repository. The stable
asset URL is referenced by the separate terminal-client repository.
