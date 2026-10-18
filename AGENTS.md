# AGENTS.md

VS Code extension **RTLens** (`package.json` name `rtlens`): Verilog/SystemVerilog reading aid — syntax highlighting, go-to-definition, connectivity webview, composition tree, wrapper generation. No bundler, no linter, no CI.

## Commands

- `make` (default) = deps → `tsc` → unit tests → e2e → `vsce package` → `dist/rtlens-0.1.3.vsix`. `make check` stops before packaging; `make contents` lists vsix files; `make help`.
- `npm run compile` = `tsc -p ./` (emits CommonJS to `out/`).
- `npm test` = compile **then** `node --test out/test/`. `npm run check` = compile then `node out/tools/e2e.js`.
- **Tests run compiled JS in `out/`, not `src/`.** After editing, recompile. `npm test`/`make test` do it; a bare `node --test out/test/` does not.
- Single test: `npx tsc -p ./ && node --test out/test/parser.test.js` (or `node --test --test-name-pattern="..." out/test/`).
- No ESLint/Prettier/EditorConfig. Do not add or assume one.
- `vsce` is not a devDependency: Makefile uses `npx --yes @vscode/vsce@4`; `npm run package` uses a bare `vsce`.

## Layout

- `src/extension.ts` → `out/extension.js` (`package.json` `main`). Activation + provider wiring.
- `src/core/*` — vscode-free pure logic (lexer, parser, resolve, index, hierarchy, graph, generator, nets, problems...). Plain-Node unit-testable.
- `src/vscode/*` — host layer, imports `vscode`: `indexService.ts` (workspace index singleton), `graphPanel.ts` (connectivity webview), `generate.ts` (wrapper: modes `auto`/`flatten`/`compose`/`stub`), `providers.ts`, `views.ts`, `config.ts`, `semantic.ts`.
- `src/test/*.test.ts` → `out/test/`. `src/tools/{e2e,dump,scalePerf}.ts` → `out/tools/` (dev-only, excluded from vsix). Fixtures in `test/fixtures/{lib,tb}`.
- `DESIGN.md` (Chinese) is the authoritative design doc **and** test/mutation log. After a behavior change, update its test counts (≈ line 572) and mutation-testing notes.

## Gotchas

- `src/core/parser.py` is a **decoy**: TypeScript source with a `.py` extension, tracked but never imported and never compiled (`tsconfig` includes only `src/**/*.ts`). The real parser is `parser.ts`. Do not edit the `.py`.
- `src/vscode/graphPanel.ts` embeds the entire webview bundle in `export const SCRIPT = String.raw\`` (≈ lines 395–1402). A backtick inside it terminates the template. There is no `media/` directory.
- `tsconfig` strict flags `noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns`/`noFallthroughCasesInSwitch` turn unused locals/params into hard compile errors.
- VS Code renders the activity-bar container icon `resources/icon.svg` as a **monochrome alpha mask** (only alpha matters, colored with the Activity Bar foreground): transparent background + `currentColor` glyph only. A filled background rect degrades it to a solid "whiteboard". `resources/icon.png` is the separate marketplace icon; the two are unrelated.
- vsce v4 treats a README relative link to a `.vscodeignore`-excluded file (e.g. `DESIGN.md`) as an **error** when there is no repository URL, failing `make`. Makefile already passes `--allow-missing-repository --skip-license` (no repo URL, no LICENSE file). `README.md` is intentionally shipped in the vsix and is vsce's marketplace page.
- Config section is `hdl.connectView.*` even though the package/extension is `rtlens` (legacy `hdl-connect-view` name lingers in Makefile help text and the package-name heredoc).

## Conventions

- Tests use `node:test`. Pure `src/core` tests do not import `vscode`. Tests touching `src/vscode` go through `src/test/vscodeStub.ts`: it intercepts `'vscode'` via a `Module._load` hook and then dynamically imports the real module (see `graphpanel.test.ts`, `webview.test.ts` — the latter runs the real `SCRIPT` in a stub DOM via `new Function`, not a copy).
- `config.test.ts` and `ranges.test.ts` are deliberate guards: `config.test.ts` cross-checks that every `HdlConfig` field is read and every `package.json` setting is consumed (no dead settings); do not weaken them.
- Parser is failure-tolerant by design (never throws, skips unknown tokens). Do not add throwing validation. Webview assets must stay self-contained (no CDN).
- e2e prints `ALL CHECKS PASSED`; a red e2e should block packaging.
