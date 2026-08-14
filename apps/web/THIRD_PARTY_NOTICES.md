# Third-Party Notices — apps/web

## DeepSeek Harness (UI framework reference)

Portions of this directory are copied from the DeepSeek Harness repository
(https://github.com/deepseek-ai/deepseek-harness), MIT License:

- `src/ui/` — copied from `packages/client/ui-primitives/src/`
  (pure React atoms: controls, icons, markdown, JSON inspectors).
- `src/styles/base.css` — copied from `packages/client/web/src/base.css`.
- `src/styles/theme/` — copied from `packages/client/ui-theme/src/styles/`
  (design tokens, scrollbar, gradient text, shiki theme sheets).
- `vite.config.ts` — vendor-chunk layout adapted from `apps/web/vite.config.ts`.

The cordis/invariants companion plugin (`src/ui/invariant.ts`) is intentionally
excluded: THETA Agent is a plain React application and does not run the
DeepSeek Harness plugin runtime.

MIT License

Copyright (c) 2026 DeepSeek

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
