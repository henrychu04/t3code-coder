# Ghostty web terminal

This directory is the browser adapter for the same official `libghostty-vt` C ABI used by Android.
It is intentionally not an xterm compatibility layer.

- `runtime.ts` owns the singleton WebAssembly instance and runtime ABI layouts.
- `ghostty-write-pty.wasm` is a 112-byte callback trampoline for terminal-generated PTY replies.
- `core.ts` owns per-terminal Ghostty handles and translates the C ABI into render snapshots.
- `renderer.ts` batches backgrounds and style runs into a Canvas 2D frame.
- `surface.ts` owns browser input, IME, selection, scrolling, sizing, links, and cursor blinking.
- `fonts/` vendors the symbols-only Nerd Font (MIT) the surface registers lazily, so
  prompt glyphs render without a locally installed Nerd Font.
- `vendor/` holds only the two required artifacts plus the upstream revision and MIT license. The
  networked upstream checkout and rebuild tooling are deliberately not included in T3 Coder.

Keep browser behavior here and terminal transport in the existing client runtime. Do not add React
state to the render loop. Both WASM artifacts are ordinary read-only assets, not executables.
