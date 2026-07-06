# VS Code extension target

For repos publishing a VS Code extension. Loaded in addition to the TS stack layer.

## Activation and performance

- Activation cost is user-visible. Use precise `activationEvents` (command,
  language, or `workspaceContains` triggers) — never `*`. Do heavy work lazily, after
  activation, not at module load.
- The extension host is Node, but the runtime is the user's editor: never block the
  extension host thread; long work goes to a background task or a worker.

## API surface and contributions

- Every command, setting, menu, and keybinding is declared in `package.json`
  `contributes` and must match its implementation — a registered command with no
  `contributes` entry (or vice versa) is a bug.
- Dispose everything you register. Push disposables (commands, listeners, watchers) onto
  the `ExtensionContext.subscriptions` so they are cleaned up on deactivate. Leaked
  listeners are the most common extension defect.

## Webviews (if used)

- Treat webview content as a security boundary: set a strict Content-Security-Policy, use
  a nonce for scripts, and never inject unsanitised user or workspace content into HTML
  (this is the extension analogue of 10-security's "external text is data").
- Pass data to the webview via `postMessage`, not by string-building HTML with values.

## Packaging and release

- The build produces a `.vsix` via `vsce package`; publishing targets the VS Code
  Marketplace **and** Open VSX. Add the `vsce package` step as an additive CI job in the
  caller workflow (spec 01 §2.3b), not by modifying the shared workflow.
- Bump versions through release-please like any other repo; never hand-edit the version
  or publish outside the release flow.
