/**
 * A stand-in for the `vscode` module.
 *
 * The extension host is where a jump, a hover or a tree actually happens, and
 * nothing else in the test suite can see it: this stub gives `out/extension.js`
 * just enough of the API to activate, index a workspace and answer provider
 * calls, so those paths are tested instead of only read. The shape follows what
 * `src/extension.ts` and `src/vscode/*` touch, not the whole VS Code API.
 */

class Position {
  constructor(public line: number, public character: number) {}
}

class Range {
  start: Position;
  end: Position;
  constructor(a: number | Position, b: number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a;
      this.end = a;
      void b;
    }
  }
}

class Selection extends Range {}

class Location {
  constructor(public uri: Uri, public range: Range) {}
}

class Uri {
  constructor(public fsPath: string) {}
  readonly scheme = 'file';
  readonly path = '';
  static file(p: string) {
    return new Uri(p);
  }
  static parse(s: string) {
    return new Uri(String(s).replace('file://', ''));
  }
  toString() {
    return 'file://' + this.fsPath;
  }
}

class EventEmitter<T> {
  private listeners: ((e: T) => unknown)[] = [];
  readonly event = (f: (e: T) => unknown) => {
    this.listeners.push(f);
    return { dispose: () => undefined };
  };
  fire(e: T) {
    for (const f of this.listeners) f(e);
  }
  dispose() {
    this.listeners = [];
  }
}

class TreeItem {
  iconPath?: unknown;
  contextValue?: string;
  tooltip?: string;
  command?: unknown;
  description?: string | boolean;
  resourceUri?: Uri;
  accessibilityInformation?: unknown;
  constructor(public label: string, public collapsibleState?: number) {}
}

class DocumentSymbol {
  children: DocumentSymbol[] = [];
  detail = '';
  constructor(
    public name: string,
    _detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range,
  ) {}
}

class Hover {
  range?: Range;
  constructor(public contents: unknown, range?: Range) {
    this.range = range;
  }
}

class MarkdownString {
  value = '';
  isTrusted = false;
  constructor(v?: string) {
    if (v) this.value = v;
  }
  appendMarkdown(v: string) {
    this.value += v;
    return this;
  }
  appendCodeblock(code: string, _lang?: string) {
    this.value += code;
    return this;
  }
}

class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(public id: string, public color?: string) {}
}

class ThemeColor {
  constructor(public id: string) {}
}

class Disposable {
  constructor(private f?: () => unknown) {}
  dispose() {
    this.f?.();
  }
  static from(...items: { dispose(): unknown }[]) {
    return new Disposable(() => items.forEach((i) => i.dispose()));
  }
}

class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}

const noop = { dispose: () => undefined };

/** A document as the providers see it - `getText` reads the current text. */
export interface StubDocument {
  uri: { scheme: string; fsPath: string; path: string; toString(): string };
  fileName: string;
  languageId: string;
  isDirty: boolean;
  lineCount: number;
  getText(): string;
}

export function documentFor(file: string, text: string): StubDocument {
  const uri = Uri.file(file);
  return {
    uri,
    fileName: file,
    languageId: file.endsWith('.sv') ? 'systemverilog' : 'verilog',
    isDirty: false,
    lineCount: text.split('\n').length,
    getText: () => text,
  };
}

const openListeners: ((doc: StubDocument) => unknown)[] = [];
const closeListeners: ((doc: StubDocument) => unknown)[] = [];

/** Everything the extension touches, mutable so a test can wire a workspace. */
const api: Record<string, any> = {
  /** Lines the extension wrote to its output channel, for failure reports. */
  __log: [] as string[],
  Position,
  Range,
  Selection,
  Location,
  Uri,
  EventEmitter,
  TreeItem,
  DocumentSymbol,
  Hover,
  MarkdownString,
  ThemeIcon,
  ThemeColor,
  RelativePattern,
  Disposable,
  SymbolKind: {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7,
    Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
    Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
    Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
  },
  SymbolTag: { Deprecated: 1 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  FileType: { File: 1, Directory: 2 },
  ProgressLocation: { Notification: 15, Window: 10 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  OverviewRulerLane: { Left:1, Center:2, Right:4, Full:7 },
  ViewColumn: { One: 1, Two: 2, Active: -1 },
  commands: {
    registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
      (api.__commands ??= {})[id] = fn;
      return noop;
    },
    executeCommand: async (id: string, ...args: unknown[]) => (api.__commands?.[id] ? api.__commands[id](...args) : undefined),
  },
  window: {
    createOutputChannel(name: string) {
      return {
        name,
        appendLine(line: string) {
          api.__log.push(`[${name}] ${line}`);
        },
        append(line: string) {
          api.__log.push(line);
        },
        show() {},
        clear() {
          api.__log.length = 0;
        },
        dispose() {},
      };
    },
    createTreeView(_id: string, opts: { onDidChangeSelection?: unknown }) {
      const change = new EventEmitter<{ selection: unknown[] }>();
      void opts;
      return {
        onDidChangeSelection: change.event,
        onDidChangeVisibility: new EventEmitter<void>().event,
        reveal: async () => undefined,
        dispose: () => undefined,
      };
    },
    createWebviewPanel() {
      const messages = new EventEmitter<unknown>();
      const posted: unknown[] = [];
      const panel = {
        webview: {
          html: '',
          onDidReceiveMessage: messages.event,
          postMessage: async (m: unknown) => {
            posted.push(m);
          },
        },
        onDidDispose: new EventEmitter<void>().event,
        reveal: () => undefined,
        dispose: () => undefined,
        // Test hooks: what the panel was told, and a way to send it messages.
        __posted: posted,
        __send: (m: unknown) => messages.fire(m),
      };
      (api.__webviews ??= []).push(panel);
      return panel;
    },
    registerWebviewViewProvider(_id: string, _provider: unknown, _opts?: unknown) {
      return noop;
    },
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showTextDocument: async () => undefined,
    showQuickPick: async (items: unknown, opts?: unknown) =>
      api.__quickPick ? api.__quickPick(items, opts) : undefined,
    showInputBox: async () => undefined,
    setStatusBarMessage: () => noop,
    createTextEditorDecorationType(opts: any) { return { key: String(((api as any).__dt=(api as any).__dt||0)+1), __options: opts, dispose(){}, options: opts }; },
    createStatusBarItem() {
      const item = {
        text: '',
        tooltip: '',
        command: '',
        name: '',
        visible: false,
        show() {
          item.visible = true;
        },
        hide() {
          item.visible = false;
        },
        dispose() {
          item.visible = false;
        },
      };
      (api.__statusBars ??= []).push(item);
      return item;
    },
    withProgress: async (_options: unknown, task: (p: { report: () => unknown }, c: unknown) => unknown) =>
      task({ report: () => undefined }, { isCancellationRequested: false }),
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => noop,
    onDidChangeTextEditorSelection: () => noop,
    onDidChangeVisibleTextEditors: () => noop,
    visibleTextEditors: [] as any[],
  },
  workspace: {
    workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
    textDocuments: [] as StubDocument[],
    getConfiguration: () => ({ get: (_k: string, fallback: unknown) => fallback }),
    getWorkspaceFolder: (uri: Uri) =>
      (api.workspace.workspaceFolders ?? []).find((f: { uri: Uri }) => uri.fsPath.startsWith(f.uri.fsPath)),
    openTextDocument: async (u: string | { fsPath: string }) =>
      documentFor(typeof u === 'string' ? u : u.fsPath, ''),
    createFileSystemWatcher: () => ({
      onDidCreate: () => noop,
      onDidChange: () => noop,
      onDidDelete: () => noop,
      dispose: () => undefined,
    }),
    onDidOpenTextDocument: (f: (d: StubDocument) => unknown) => {
      openListeners.push(f);
      return noop;
    },
    onDidCloseTextDocument: (f: (d: StubDocument) => unknown) => {
      closeListeners.push(f);
      return noop;
    },
    onDidChangeTextDocument: (f: any) => { (api as any).__docListeners=f; return noop; },
    onDidSaveTextDocument: () => noop,
    onDidChangeConfiguration: () => noop,
    onDidChangeWorkspaceFolders: () => noop,
    onDidChangeWorkspaceState: () => noop,
    findFiles: async () => [] as Uri[],
    asRelativePath: (p: string) => p,
    fs: {
      readFile: async () => new Uint8Array(),
      stat: async () => ({ type: 1, size: 0 }),
    },
  },
  languages: {
    registerDocumentSemanticTokensProvider: () => noop,
    registerDefinitionProvider: (_sel: unknown, p: unknown) => {
      api.__definition = p;
      return noop;
    },
    registerHoverProvider: (_sel: unknown, p: unknown) => {
      api.__hover = p;
      return noop;
    },
    registerReferenceProvider: (_sel: unknown, p: unknown) => {
      api.__references = p;
      return noop;
    },
    registerRenameProvider: (_sel: unknown, p: unknown) => {
      api.__rename = p;
      return noop;
    },
    registerDocumentSymbolProvider: (_sel: unknown, p: unknown) => {
      api.__symbols = p;
      return noop;
    },
  },
  SemanticTokensBuilder: class {
    private tokens: number[] = [];
    push(...args: number[]) {
      this.tokens.push(...args);
    }
    build() {
      return { data: new Uint32Array(this.tokens) };
    }
  },
  SemanticTokensLegend: class {
    tokenTypes: string[] = [];
    tokenModifiers: string[] = [];
  },
};

/** Announce an opened document, the way `onDidOpenTextDocument` does. */
export function fireOpen(doc: StubDocument): void {
  api.workspace.textDocuments.push(doc);
  for (const f of openListeners) f(doc);
}

/** Announce a closed document. */
export function fireClose(doc: StubDocument): void {
  const i = api.workspace.textDocuments.indexOf(doc);
  if (i >= 0) {
    api.workspace.textDocuments.splice(i, 1);
  }
  for (const f of closeListeners) f(doc);
}

/** The providers the extension registered, by name. */
export function provider(name: 'definition' | 'hover' | 'references' | 'rename' | 'symbols') {
  return api[`__${name}`];
}

/** Lines the extension logged to its output channel. */
export function log(): string[] {
  return api.__log;
}

export const vscode = api;
export default api;
