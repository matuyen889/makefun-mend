import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function trimEndSpacesTabs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return s.slice(0, i);
}

function trimSpacesTabs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let j = s.length;
  while (j > i && (s[j - 1] === ' ' || s[j - 1] === '\t')) j--;
  return s.slice(i, j);
}

function getLeadingSpacesTabs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(0, i);
}

interface MatchResult {
  tier: number;
  positions: number[];
}

function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  startPos = 0,
  mustEndAtEOF = false
): MatchResult | null {
  const m = oldLines.length;
  if (m === 0) return null;
  const maxTier = strict ? 0 : 2;

  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = startPos; i <= fileLines.length - m; i++) {
      if (mustEndAtEOF && i + m !== fileLines.length) continue;
      let ok = true;
      for (let k = 0; k < m; k++) {
        const fl = fileLines[i + k]!;
        const ol = oldLines[k]!;
        if (tier === 0) {
          if (fl !== ol) { ok = false; break; }
        } else if (tier === 1) {
          if (trimEndSpacesTabs(fl) !== trimEndSpacesTabs(ol)) { ok = false; break; }
        } else {
          if (trimSpacesTabs(fl) !== trimSpacesTabs(ol)) { ok = false; break; }
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) {
      return { tier, positions };
    }
  }
  return null;
}

interface FileState {
  lines: string[];
  crlf: boolean;
  finalBreak: boolean;
  deleted: boolean;
}

/** The tree as the edits leave it */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, FileState | null>();
  readonly moves = new Map<string, string>(); // newPath -> oldPath

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  getFile(p: string): FileState | null {
    if (this.now.has(p)) return this.now.get(p)!;
    const text = this.original(p);
    if (text === null) return null;
    const nl = text.indexOf('\n');
    const crlf = nl > 0 && text[nl - 1] === '\r';
    const br = crlf ? '\r\n' : '\n';
    const lines = text === '' ? [] : text.split(br);
    const finalBreak = text !== '' && text.endsWith(br);
    if (finalBreak) lines.pop();
    const state: FileState = { lines, crlf, finalBreak, deleted: false };
    this.now.set(p, state);
    return state;
  }

  setFile(p: string, state: FileState | null): void {
    this.now.set(p, state);
  }

  getText(p: string): string | null {
    const s = this.getFile(p);
    if (s === null || s.deleted) return null;
    const br = s.crlf ? '\r\n' : '\n';
    if (s.lines.length === 0) return '';
    return s.lines.join(br) + (s.finalBreak ? br : '');
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// -------------------------------------------------------------
// SECTION 9: JSON edits
// -------------------------------------------------------------
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const existing = tree.getFile(p);
      if (existing !== null && !existing.deleted) throw new Fail('exists', p);
      const nl = text.indexOf('\n');
      const crlf = nl > 0 && text[nl - 1] === '\r';
      const br = crlf ? '\r\n' : '\n';
      const lines = text === '' ? [] : text.split(br);
      const finalBreak = text !== '' && text.endsWith(br);
      if (finalBreak) lines.pop();
      tree.setFile(p, { lines, crlf, finalBreak, deleted: false });
    };
  }

  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const file = tree.getFile(p);
      if (file === null || file.deleted) throw new Fail('missing', p);

      const before = tree.getText(p)!;
      const crlf = file.crlf;
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      const resText = crlf ? out.replaceAll('\n', '\r\n') : out;

      const br = crlf ? '\r\n' : '\n';
      const lines = resText === '' ? [] : resText.split(br);
      const finalBreak = resText !== '' && resText.endsWith(br);
      if (finalBreak) lines.pop();
      tree.setFile(p, { lines, crlf, finalBreak, deleted: false });
    };
  }

  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const file = tree.getFile(p);
      if (file === null || file.deleted) throw new Fail('missing', p);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// -------------------------------------------------------------
// SECTION 7: SEARCH/REPLACE blocks
// -------------------------------------------------------------
function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      const searchLineNum = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const lineBefore = lines[j]!;
        if (lineBefore.trimEnd() === '>>>>>>> REPLACE') break;
        if (!blank(lineBefore)) {
          const s = lineBefore.trim();
          if (!s.startsWith('```')) {
            path = s;
            break;
          }
        }
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLineNum}`);
      prevPath = path;

      const oldLines: string[] = [];
      let j = i + 1;
      let foundEqual = false;
      while (j < lines.length) {
        if (lines[j]!.trimEnd() === '=======') {
          foundEqual = true;
          break;
        }
        oldLines.push(lines[j]!);
        j++;
      }
      if (!foundEqual) throw new Exit2(`error: parse ${searchLineNum}`);

      const newLines: string[] = [];
      let k = j + 1;
      let foundReplace = false;
      while (k < lines.length) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          foundReplace = true;
          break;
        }
        newLines.push(lines[k]!);
        k++;
      }
      if (!foundReplace) throw new Exit2(`error: parse ${searchLineNum}`);

      const targetPath = path;
      edits.push((tree, strict) => {
        if (!safe(targetPath)) throw new Fail('unsafe', targetPath);
        if (oldLines.length === 0) {
          const existing = tree.getFile(targetPath);
          if (existing !== null && !existing.deleted) throw new Fail('exists', targetPath);
          tree.setFile(targetPath, { lines: [...newLines], crlf: false, finalBreak: true, deleted: false });
        } else {
          const file = tree.getFile(targetPath);
          if (file === null || file.deleted) throw new Fail('missing', targetPath);
          const match = findOccurrences(file.lines, oldLines, strict);
          if (match === null) throw new Fail('no-match', targetPath);
          if (match.positions.length > 1) throw new Fail('ambiguous', targetPath);

          const at = match.positions[0]!;
          const tier = match.tier;
          const F = getLeadingSpacesTabs(file.lines[at]!);
          const P = getLeadingSpacesTabs(oldLines[0]!);

          const replacementLines: string[] = [];
          for (const nl of newLines) {
            if (tier === 2 && nl.trim() !== '' && nl.startsWith(P)) {
              replacementLines.push(F + nl.slice(P.length));
            } else {
              replacementLines.push(nl);
            }
          }

          file.lines.splice(at, oldLines.length, ...replacementLines);
        }
      });

      i = k + 1;
    } else {
      i++;
    }
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// -------------------------------------------------------------
// SECTION 8: V4A patches
// -------------------------------------------------------------
interface V4AChunk {
  anchor: string | null;
  isEOF: boolean;
  O: string[];
  N_items: { isContext: boolean; oIndex: number; text: string }[];
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);

  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const l = lines[i]!;

    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !lines[i]!.startsWith('*** ') && (lines[i]!.startsWith('+') || lines[i] === '')) {
        fileLines.push(lines[i]!.startsWith('+') ? lines[i]!.slice(1) : lines[i]!);
        i++;
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const existing = tree.getFile(p);
        if (existing !== null && !existing.deleted) throw new Fail('exists', p);
        tree.setFile(p, { lines: fileLines, crlf: false, finalBreak: true, deleted: false });
      });
      continue;
    }

    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      i++;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const existing = tree.getFile(p);
        if (existing === null || existing.deleted) throw new Fail('missing', p);
        existing.deleted = true;
      });
      continue;
    }

    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(17).trim();
      const updateLineNum = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }

      const chunks: V4AChunk[] = [];
      while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ') && lines[i]!.trim() !== '*** End Patch') {
        if (blank(lines[i]!)) { i++; continue; }
        let anchor: string | null = null;
        let isEOF = false;

        if (lines[i]!.startsWith('@@')) {
          const aText = lines[i]!.slice(2).trim();
          anchor = aText === '' ? null : aText;
          i++;
        }

        const rawChunkLines: string[] = [];
        while (i < last) {
          const cl = lines[i]!;
          if (cl.startsWith('*** End of File')) {
            isEOF = true;
            i++;
            break;
          }
          if (cl.startsWith('*** ') || cl.startsWith('@@')) break;
          rawChunkLines.push(cl);
          i++;
        }

        // Blank lines at end of chunk/section are not part of it
        if (i >= last || lines[i]!.startsWith('*** ')) {
          while (rawChunkLines.length > 0 && rawChunkLines[rawChunkLines.length - 1]!.trim() === '') {
            rawChunkLines.pop();
          }
        }

        const O: string[] = [];
        const N_items: { isContext: boolean; oIndex: number; text: string }[] = [];

        for (let idx = 0; idx < rawChunkLines.length; idx++) {
          const cl = rawChunkLines[idx]!;
          if (cl.startsWith(' ') || cl === '') {
            const text = cl.startsWith(' ') ? cl.slice(1) : cl;
            const oIndex = O.length;
            O.push(text);
            N_items.push({ isContext: true, oIndex, text });
          } else if (cl.startsWith('-')) {
            O.push(cl.slice(1));
          } else if (cl.startsWith('+')) {
            N_items.push({ isContext: false, oIndex: -1, text: cl.slice(1) });
          } else {
            throw new Exit2(`error: parse ${i + 1}`);
          }
        }

        chunks.push({ anchor, isEOF, O, N_items });
      }

      if (chunks.length === 0 && moveTo === null) {
        throw new Exit2(`error: parse ${updateLineNum}`);
      }

      edits.push((tree, strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const file = tree.getFile(p);
        if (file === null || file.deleted) throw new Fail('missing', p);
        if (moveTo !== null) {
          const dest = tree.getFile(moveTo);
          if (dest !== null && !dest.deleted) throw new Fail('exists', moveTo);
        }

        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const mAnchor = findOccurrences(file.lines, [chunk.anchor], strict, cursor);
            if (mAnchor === null) throw new Fail('no-match', p);
            cursor = mAnchor.positions[0]! + 1;
          }

          if (chunk.O.length === 0) {
            const insertAt = chunk.isEOF ? file.lines.length : cursor;
            const insertedLines = chunk.N_items.map((it) => it.text);
            file.lines.splice(insertAt, 0, ...insertedLines);
            cursor = insertAt + insertedLines.length;
          } else {
            const m = findOccurrences(file.lines, chunk.O, strict, cursor, chunk.isEOF);
            if (m === null) throw new Fail('no-match', p);
            const at = m.positions[0]!;
            const tier = m.tier;

            const F = getLeadingSpacesTabs(file.lines[at]!);
            const P = getLeadingSpacesTabs(chunk.O[0]!);

            const replacement: string[] = [];
            for (const item of chunk.N_items) {
              if (item.isContext) {
                replacement.push(file.lines[at + item.oIndex]!);
              } else {
                if (tier === 2 && item.text.trim() !== '' && item.text.startsWith(P)) {
                  replacement.push(F + item.text.slice(P.length));
                } else {
                  replacement.push(item.text);
                }
              }
            }

            file.lines.splice(at, chunk.O.length, ...replacement);
            cursor = at + replacement.length;
          }
        }

        if (moveTo !== null) {
          file.deleted = true;
          tree.setFile(moveTo, { lines: [...file.lines], crlf: file.crlf, finalBreak: file.finalBreak, deleted: false });
          tree.moves.set(moveTo, p);
        }
      });
      continue;
    }

    throw new Exit2(`error: parse ${i + 1}`);
  }

  return edits;
}

// -------------------------------------------------------------
// SECTION 6: Unified diffs
// -------------------------------------------------------------
function cleanDiffPath(raw: string): string {
  let s = raw.trim();
  const tabIdx = s.indexOf('\t');
  if (tabIdx >= 0) s = s.slice(0, tabIdx).trim();
  if (s === '/dev/null') return '/dev/null';
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

interface UnifiedHunk {
  A: number;
  C: number;
  lines: string[];
}

function unifiedEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      let oldPath: string | null = null;
      let newPath: string | null = null;
      let isNew = false;
      let isDelete = false;
      let renameFrom: string | null = null;
      let renameTo: string | null = null;

      if (l.startsWith('diff --git ')) {
        const parts = l.split(' ');
        if (parts.length >= 4) {
          oldPath = cleanDiffPath(parts[2]!);
          newPath = cleanDiffPath(parts[3]!);
        }
        i++;
      }

      while (i < lines.length && !lines[i]!.startsWith('@@') && !lines[i]!.startsWith('diff --git ')) {
        const hl = lines[i]!;
        if (hl.startsWith('--- ')) {
          if (!((lines[i + 1] ?? '').startsWith('+++ '))) {
            throw new Exit2(`error: parse ${i + 2}`);
          }
          oldPath = cleanDiffPath(hl.slice(4));
          newPath = cleanDiffPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        if (hl.startsWith('rename from ')) renameFrom = hl.slice(12).trim();
        else if (hl.startsWith('rename to ')) renameTo = hl.slice(10).trim();
        else if (hl.startsWith('new file mode')) isNew = true;
        else if (hl.startsWith('deleted file mode')) isDelete = true;
        i++;
      }

      if (renameFrom && renameTo) {
        oldPath = renameFrom;
        newPath = renameTo;
      }

      const hunks: UnifiedHunk[] = [];
      while (i < lines.length && !lines[i]!.startsWith('diff --git ') && !(lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        if (lines[i]!.startsWith('@@')) {
          const hm = lines[i]!.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
          if (!hm) throw new Exit2(`error: parse ${i + 1}`);
          const A = parseInt(hm[1]!, 10);
          const C = parseInt(hm[2]!, 10);
          i++;

          const hunkLines: string[] = [];
          while (i < lines.length) {
            const bl = lines[i]!;
            if (bl.startsWith('@@') || bl.startsWith('diff --git ') || (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
              break;
            }
            if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
              hunkLines.push(bl);
              i++;
            } else {
              break;
            }
          }
          while (hunkLines.length > 0 && hunkLines[hunkLines.length - 1] === '') {
            hunkLines.pop();
          }
          hunks.push({ A, C, lines: hunkLines });
        } else {
          i++;
        }
      }

      const finalOld = oldPath;
      const finalNew = newPath;
      const creation = isNew || finalOld === '/dev/null';
      const deletion = isDelete || finalNew === '/dev/null';
      const move = !creation && !deletion && finalOld !== null && finalNew !== null && finalOld !== finalNew;

      edits.push((tree, strict) => {
        if (creation) {
          const p = finalNew!;
          if (!safe(p)) throw new Fail('unsafe', p);
          const existing = tree.getFile(p);
          if (existing !== null && !existing.deleted) throw new Fail('exists', p);

          const added: string[] = [];
          let hasNoNewline = false;
          for (const hunk of hunks) {
            for (let k = 0; k < hunk.lines.length; k++) {
              const hl = hunk.lines[k]!;
              if (hl.startsWith('+')) added.push(hl.slice(1));
              else if (hl.startsWith('\\')) hasNoNewline = true;
            }
          }
          tree.setFile(p, { lines: added, crlf: false, finalBreak: !hasNoNewline, deleted: false });
          return;
        }

        if (deletion) {
          const p = finalOld!;
          if (!safe(p)) throw new Fail('unsafe', p);
          const file = tree.getFile(p);
          if (file === null || file.deleted) throw new Fail('missing', p);
          file.deleted = true;
          return;
        }

        const srcPath = finalOld!;
        const dstPath = finalNew!;
        if (!safe(srcPath)) throw new Fail('unsafe', srcPath);
        if (!safe(dstPath)) throw new Fail('unsafe', dstPath);

        const file = tree.getFile(srcPath);
        if (file === null || file.deleted) throw new Fail('missing', srcPath);
        if (move) {
          const dest = tree.getFile(dstPath);
          if (dest !== null && !dest.deleted) throw new Fail('exists', dstPath);
        }

        let d = 0;
        for (const hunk of hunks) {
          const O: string[] = [];
          const N_items: { isContext: boolean; oIndex: number; text: string }[] = [];
          let noNewline = false;

          for (let k = 0; k < hunk.lines.length; k++) {
            const hl = hunk.lines[k]!;
            if (hl.startsWith('\\')) {
              noNewline = true;
              continue;
            }
            if (hl.startsWith(' ') || hl === '') {
              const text = hl.startsWith(' ') ? hl.slice(1) : hl;
              const oIndex = O.length;
              O.push(text);
              N_items.push({ isContext: true, oIndex, text });
            } else if (hl.startsWith('-')) {
              O.push(hl.slice(1));
            } else if (hl.startsWith('+')) {
              N_items.push({ isContext: false, oIndex: -1, text: hl.slice(1) });
            }
          }

          if (O.length === 0) {
            const insertPos = Math.min(hunk.A + d, file.lines.length);
            const insertedLines = N_items.map((it) => it.text);
            file.lines.splice(insertPos, 0, ...insertedLines);
            if (insertPos === file.lines.length && noNewline) file.finalBreak = false;
            d += insertedLines.length;
          } else {
            const m = findOccurrences(file.lines, O, strict);
            if (m === null) throw new Fail('no-match', srcPath);

            const targetPos = hunk.A - 1 + d;
            let bestPos = m.positions[0]!;
            let bestDist = Math.abs(bestPos - targetPos);
            for (let idx = 1; idx < m.positions.length; idx++) {
              const pos = m.positions[idx]!;
              const dist = Math.abs(pos - targetPos);
              if (dist < bestDist) {
                bestDist = dist;
                bestPos = pos;
              }
            }

            const at = bestPos;
            const tier = m.tier;
            const F = getLeadingSpacesTabs(file.lines[at]!);
            const P = getLeadingSpacesTabs(O[0]!);

            const replacement: string[] = [];
            for (const item of N_items) {
              if (item.isContext) {
                replacement.push(file.lines[at + item.oIndex]!);
              } else {
                if (tier === 2 && item.text.trim() !== '' && item.text.startsWith(P)) {
                  replacement.push(F + item.text.slice(P.length));
                } else {
                  replacement.push(item.text);
                }
              }
            }

            file.lines.splice(at, O.length, ...replacement);
            if (at + O.length >= file.lines.length && noNewline) {
              file.finalBreak = false;
            }
            d += N_items.length - O.length;
          }
        }

        if (move) {
          file.deleted = true;
          tree.setFile(dstPath, { lines: [...file.lines], crlf: file.crlf, finalBreak: file.finalBreak, deleted: false });
          tree.moves.set(dstPath, srcPath);
        }
      });
      continue;
    }
    i++;
  }

  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// -------------------------------------------------------------
// MAIN RUNNER
// -------------------------------------------------------------
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else return { code: 2, out: ['error: format'] };
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const beforeNow = new Map<string, FileState | null>();
    for (const [k, v] of tree.now) {
      beforeNow.set(k, v === null ? null : { ...v, lines: [...v.lines] });
    }
    const beforeMoves = new Map(tree.moves);

    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`]
    };
  }

  const rows: { sortKey: string; line: string }[] = [];
  const processedPaths = new Set<string>();

  for (const [newP, oldP] of tree.moves) {
    const was = tree.original(oldP);
    const nowState = tree.now.get(newP);
    const nowText = nowState && !nowState.deleted ? tree.getText(newP) : null;
    const oldState = tree.now.get(oldP);
    const oldDeleted = oldState && oldState.deleted;

    if (was !== null && oldDeleted && nowText !== null) {
      rows.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
      processedPaths.add(oldP);
      processedPaths.add(newP);
      if (!check) {
        rmSync(oldP, { force: true });
        mkdirSync(dirname(newP), { recursive: true });
        writeFileSync(newP, nowText);
      }
    }
  }

  for (const p of [...tree.now.keys()]) {
    if (processedPaths.has(p)) continue;
    const was = tree.original(p);
    const state = tree.now.get(p);
    const now = state && !state.deleted ? tree.getText(p) : null;

    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ sortKey: p, line: `${tag} ${p}` });
    if (check) continue;
    if (now === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }

  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const outLines = rows.map((r) => r.line);
  return {
    code: 0,
    out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`]
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
