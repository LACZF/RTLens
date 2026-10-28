import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { IndexService } from './indexService';

export class HdlIncludeLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly svc: IndexService) {}

  provideDocumentLinks(document: vscode.TextDocument): vscode.ProviderResult<vscode.DocumentLink[]> {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    const file = document.fileName;
    const re = /`include\s+["<]([^">]+)[">]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const inc = match[1];
      const incStart = match.index + match[0].indexOf(inc);
      const incEnd = incStart + inc.length;
      const start = document.positionAt(incStart);
      const end = document.positionAt(incEnd);
      const range = new vscode.Range(start, end);
      const resolved = this.resolve(file, inc);
      if (resolved) {
        links.push(new vscode.DocumentLink(range, vscode.Uri.file(resolved)));
      } else {
        const dir = path.dirname(file);
        const cand = path.join(dir, inc);
        links.push(new vscode.DocumentLink(range, vscode.Uri.file(cand)));
      }
    }
    return links;
  }

  private resolve(fromFile: string, inc: string): string | undefined {
    try {
      const idx: any = (this.svc as any).index;
      if (idx && typeof idx.resolveInclude === 'function') {
        const hit = idx.resolveInclude(fromFile, inc);
        if (hit && fs.existsSync(hit)) return hit;
      }
      const dir = path.dirname(fromFile);
      const cands: string[] = [path.join(dir, inc), path.resolve(dir, inc)];
      const cfg: any = (this.svc as any).config;
      if (cfg?.includeDirs) {
        for (const d of cfg.includeDirs) {
          if (path.isAbsolute(d)) {
            cands.push(path.join(d, inc));
          } else {
            cands.push(path.join(dir, d, inc));
            cands.push(path.resolve(dir, d, inc));
          }
        }
      }
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (ws) {
        cands.push(path.join(ws, inc));
        cands.push(path.join(ws, 'src', inc));
      }
      for (const c of cands) {
        if (fs.existsSync(c)) return c;
      }
      if (idx && typeof idx.allFiles === 'function') {
        const want = path.basename(inc);
        for (const f of idx.allFiles()) {
          if (path.basename(f) === want) return f;
        }
      }
    } catch {}
    return undefined;
  }
}
