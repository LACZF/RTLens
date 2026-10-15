import * as vscode from 'vscode';

import { wordAtPosition } from '../core/resolve';
import { findWordMatches, randomHighlightColor } from '../core/wordHighlight';

/**
 * Global (open-editors) word highlight toggled by F8.
 *
 * - Turning on: finds the identifier under the active cursor and highlights every
 *   standalone occurrence of it in every visible editor (whole-token match).
 * - Turning on again for the same word: clears it (toggle off).
 * - Turning on for a different word: clears the previous and highlights the new.
 * - The colour is picked at random each time highlighting is enabled.
 */
export class WordHighlighter implements vscode.Disposable {
  private active?: {
    word: string;
    decoration: vscode.TextEditorDecorationType;
  };
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.reapply()),
      vscode.workspace.onDidChangeTextDocument(() => this.reapply()),
    );
  }

  /** Toggle highlighting for the word under the active cursor. */
  toggle(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const pos = editor.selection.active;
    const found = wordAtPosition(editor.document.getText(), pos.line, pos.character);
    if (!found || !found.name) {
      // Cursor is not on an identifier; ignore rather than clearing an existing
      // highlight, so an accidental F8 does not lose a deliberate one.
      return;
    }
    const word = found.name;
    if (this.active?.word === word) {
      this.clear();
      return;
    }
    this.clear();
    const color = randomHighlightColor();
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color.background,
      border: color.border,
      overviewRulerColor: color.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      borderRadius: '2px',
    });
    this.active = { word, decoration };
    this.reapply();
  }

  /** The currently highlighted word, or `undefined` if none is active. */
  get word(): string | undefined {
    return this.active?.word;
  }

  private reapply(): void {
    const active = this.active;
    if (!active) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const text = editor.document.getText();
      const ranges = findWordMatches(text, active.word).map(
        (m) => new vscode.Range(m.line, m.startChar, m.line, m.endChar),
      );
      editor.setDecorations(active.decoration, ranges);
    }
  }

  private clear(): void {
    const active = this.active;
    if (!active) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(active.decoration, []);
    }
    active.decoration.dispose();
    this.active = undefined;
  }

  dispose(): void {
    this.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
