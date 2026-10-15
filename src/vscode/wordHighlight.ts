import * as vscode from 'vscode';

import { wordAtPosition } from '../core/resolve';
import { findWordMatches, randomHighlightColor } from '../core/wordHighlight';

interface ActiveHighlight {
  word: string;
  decoration: vscode.TextEditorDecorationType;
}

/**
 * Global (open-editors) word highlight toggled by F8.
 *
 * - Turning on: finds the identifier under the active cursor and highlights every
 *   standalone occurrence of it in every visible editor (whole-token match).
 * - Turning on again for the same word: removes its highlight (toggle off).
 * - Different words stay highlighted simultaneously; decorations do not interfere.
 * - The colour is picked at random each time a word is highlighted.
 */
export class WordHighlighter implements vscode.Disposable {
  private readonly active: ActiveHighlight[] = [];
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
      return;
    }
    const word = found.name;
    const idx = this.active.findIndex((a) => a.word === word);
    if (idx >= 0) {
      this.remove(idx);
      return;
    }
    const color = randomHighlightColor();
    const decoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color.background,
      border: color.border,
      overviewRulerColor: color.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      borderRadius: '2px',
    });
    this.active.push({ word, decoration });
    this.reapply();
  }

  /** Currently highlighted words. */
  get words(): string[] {
    return this.active.map((a) => a.word);
  }

  private reapply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const text = editor.document.getText();
      for (const a of this.active) {
        const ranges = findWordMatches(text, a.word).map(
          (m) => new vscode.Range(m.line, m.startChar, m.line, m.endChar),
        );
        editor.setDecorations(a.decoration, ranges);
      }
    }
  }

  private remove(idx: number): void {
    if (idx < 0 || idx >= this.active.length) return;
    const [a] = this.active.splice(idx, 1);
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(a.decoration, []);
    }
    a.decoration.dispose();
    this.reapply();
  }

  private clearAll(): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      for (const editor of vscode.window.visibleTextEditors) {
        editor.setDecorations(a.decoration, []);
      }
      a.decoration.dispose();
    }
    this.active.length = 0;
  }

  dispose(): void {
    this.clearAll();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
