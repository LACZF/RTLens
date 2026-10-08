import * as vscode from 'vscode';

import type { IndexService } from './indexService';
import { computeTokens, TOKEN_TYPES, type TokenType } from '../core/tokens';

const MODIFIERS = ['declaration', 'definition', 'readonly'] as const;

/**
 * The grammar colours keywords; this adds the meaning - an identifier is a
 * module type, an instance label, a port of the instantiated module, a declared
 * signal, a parameter, ... The rules live in `core/tokens` so they can be tested
 * without an extension host; this class only encodes the result.
 */
export class HdlSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  static readonly legend = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...MODIFIERS]);

  constructor(private readonly svc: IndexService) {}

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(HdlSemanticTokensProvider.legend);
    if (!this.svc.config.semanticHighlighting) {
      // Off means off: the TextMate grammar keeps colouring keywords, and an
      // empty token set is the documented way to say "this provider has
      // nothing to add".
      return builder.build();
    }
    this.svc.syncOpenDocuments();
    const index = this.svc.index;
    // The builder encodes offsets as deltas, so a token that goes backwards
    // corrupts every token after it. Sorting and de-duplicating is done once for
    // the whole file rather than per module: a file can hold several modules,
    // and their tokens have to end up in one ascending sequence.
    for (const t of computeTokens(index, index.modulesInFile(document.fileName))) {
      builder.push(t.line, t.character, t.length, TOKEN_TYPES.indexOf(t.type), 0);
    }
    return builder.build();
  }
}

export type { TokenType };
export { TOKEN_TYPES };
