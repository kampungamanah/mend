// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Moves recorded by move edits, as [old, new] pairs, for the R output lines. */
  readonly moves: [string, string][] = [];
}

// ---------- Section 5: files as lines, and three-tier matching ----------

interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const parts = text.split(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEqAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trailWs(a.replace(/^[ \t]+/, '')) === trailWs(b.replace(/^[ \t]+/, ''));
}

/** Positions (>= minPos) of O in the file's lines at the first tier with any, or null. */
function findOccurrences(file: string[], o: string[], strict: boolean, minPos = 0): { tier: number; positions: number[] } | null {
  if (o.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions: number[] = [];
    for (let i = minPos; i + o.length <= file.length; i++) {
      let ok = true;
      for (let k = 0; k < o.length; k++) {
        if (!lineEqAt(file[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
}

/**
 * Build the replacement lines for a matched occurrence.
 * Context lines of N are written as the file's own matched lines; at tier 2 the
 * other lines of N are re-indented from O's first line to the file's first matched line.
 */
function buildReplacement(o: OLine[], n: NLine[], file: string[], at: number, tier: number): string[] {
  const oCtxIndex: number[] = [];
  for (let i = 0; i < o.length; i++) if (o[i]!.ctx) oCtxIndex.push(i);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(file[at] ?? '');
    p = leadWs(o[0]!.text);
  }
  const out: string[] = [];
  let seenCtx = 0;
  for (const ne of n) {
    if (ne.ctx) {
      out.push(file[at + oCtxIndex[seenCtx]!]!);
      seenCtx++;
    } else {
      let t = ne.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------- Section 6: unified diffs ----------

interface Hunk {
  a: number;
  o: OLine[];
  n: NLine[];
  noNL: boolean;
  noNLPlus: boolean;
}

interface UniSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  gitOld: string | null | undefined;
  gitNew: string | null | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAB(t);
}

function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: { kind: string; text: string }[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      i++;
      continue;
    }
    const ch = l[0]!;
    if (ch === ' ' || ch === '-' || ch === '+') {
      body.push({ kind: ch, text: l.slice(1) });
      i++;
      continue;
    }
    if (ch === '\\') {
      body.push({ kind: '\\', text: l });
      i++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const b = body[body.length - 1]!;
    if (b.kind === ' ' && b.text === '') body.pop();
    else break;
  }
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push({ text: b.text, ctx: true });
      n.push({ text: b.text, ctx: true });
    } else if (b.kind === '-') o.push({ text: b.text, ctx: false });
    else if (b.kind === '+') n.push({ text: b.text, ctx: false });
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') lastCtxPlus = k;
    if (body[k]!.kind === '+') lastPlus = k;
  }
  const noNL = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.kind === '\\';
  const noNLPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.kind === '\\';
  return { hunk: { a: 0, o, n, noNL, noNLPlus }, next: i };
}

function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const oldLen = f.lines.length;
      const pos = Math.min(h.a + d, oldLen);
      const ins = h.n.map((e) => e.text);
      f.lines.splice(pos, 0, ...ins);
      if (pos === oldLen) f.endsWithBreak = !h.noNL;
      d += h.n.length;
      continue;
    }
    const found = findOccurrences(f.lines, h.o.map((e) => e.text), strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const pos of found.positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = buildReplacement(h.o, h.n, f.lines, best, found.tier);
    const reachesEnd = best + h.o.length === f.lines.length;
    f.lines.splice(best, h.o.length, ...rep);
    if (reachesEnd) f.endsWithBreak = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return f;
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP: string | null = s.dashOld !== undefined ? s.dashOld : s.renOld !== undefined ? s.renOld : (s.gitOld ?? null);
    const newP: string | null = s.dashNew !== undefined ? s.dashNew : s.renNew !== undefined ? s.renNew : (s.gitNew ?? null);
    for (const p of [oldP, newP]) {
      if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    }
    if (s.isCreate || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const contentLines: string[] = [];
      for (const h of s.hunks) for (const ne of h.n) if (!ne.ctx) contentLines.push(ne.text);
      let endsBreak = true;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.n.some((e) => !e.ctx)) {
          endsBreak = !h.noNLPlus;
          break;
        }
      }
      tree.now.set(newP, contentLines.length === 0 ? '' : contentLines.join('\n') + (endsBreak ? '\n' : ''));
      return;
    }
    if (s.isDelete || newP === null) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = applyHunks(splitFile(tree.get(oldP)!), s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const f = applyHunks(splitFile(tree.get(oldP)!), s.hunks, strict, oldP);
    tree.now.set(oldP, joinFile(f));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (gitOld?: string, gitNew?: string): UniSection => {
    const s: UniSection = {
      dashOld: undefined, dashNew: undefined, renOld: undefined, renNew: undefined,
      gitOld, gitNew, isCreate: false, isDelete: false, hunks: [],
    };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!.trim());
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(l);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const parsed = parseHunkBody(lines, i + 1);
      parsed.hunk.a = Number(hm[1]);
      cur.hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ') === false) throw new Exit2(`error: parse ${i + 2}`);
        cur.dashOld = headerPath(l.slice(4));
        cur.dashNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = stripAB(l.slice(12).trim());
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = stripAB(l.slice(10).trim());
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      inHeader = true;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) edits.push(unifiedSectionEdit(s, strict));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  o: OLine[];
  n: NLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  chunks: VChunk[];
  moveTo: string | null;
}

function findAnchor(file: string[], anchor: string, strict: boolean, minPos: number): number | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = minPos; i < file.length; i++) {
      if (lineEqAt(file[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

function parseV4AChunks(raw: string[], baseLine: number): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; body: { kind: string; text: string }[]; eof: boolean } | null = null;
  const flush = () => {
    if (cur === null) return;
    const o: OLine[] = [];
    const n: NLine[] = [];
    for (const b of cur.body) {
      if (b.kind === ' ') {
        o.push({ text: b.text, ctx: true });
        n.push({ text: b.text, ctx: true });
      } else if (b.kind === '-') o.push({ text: b.text, ctx: false });
      else if (b.kind === '+') n.push({ text: b.text, ctx: false });
    }
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    const lineNo = baseLine + k + 1;
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (l.startsWith('@@')) {
      flush();
      cur = { anchor: l.slice(2).trim() || null, body: [], eof: false };
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) cur = { anchor: null, body: [], eof: false };
      const kind = l === '' ? ' ' : l[0]!;
      cur.body.push({ kind, text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  return chunks;
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const text = tree.get(s.path);
    if (text === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const a = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (a === null) throw new Fail('no-match', s.path);
        cursor = a + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findOccurrences(f.lines, ch.o.map((e) => e.text), strict, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let at: number | null = null;
      for (const pos of found.positions) {
        if (ch.eof && pos + ch.o.length !== f.lines.length) continue;
        at = pos;
        break;
      }
      if (at === null) throw new Fail('no-match', s.path);
      const rep = buildReplacement(ch.o, ch.n, f.lines, at, found.tier);
      f.lines.splice(at, ch.o.length, ...rep);
      cursor = at + rep.length;
    }
    const out = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, out);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:') && (l.length === 13 || l[13] === ' ')) return 'add';
    if (l.startsWith('*** Delete File:') && (l.length === 16 || l[16] === ' ')) return 'delete';
    if (l.startsWith('*** Update File:') && (l.length === 16 || l[16] === ' ')) return 'update';
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const kind = sectionStart(l);
    if (kind === null) {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const markerLen = kind === 'add' ? 13 : 16;
    const path = l.slice(markerLen).trim();
    const headerLine = i + 1;
    let j = i + 1;
    while (j < last && sectionStart(lines[j]!) === null) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    const sec: VSection = { kind, path, headerLine, addLines: [], chunks: [], moveTo: null };
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl === '') sec.addLines.push('');
        else if (rl.startsWith('+')) sec.addLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
    } else {
      let base = i + 1;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to:') && (raw[0]!.length === 12 || raw[0]![12] === ' ')) {
        sec.moveTo = raw[0]!.slice(12).trim();
        raw.shift();
        base++;
      }
      sec.chunks = parseV4AChunks(raw, base);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    }
    sections.push(sec);
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSectionEdit(s, strict));
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let sep = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep === -1) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    const oldText = oldLines;
    const newText = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const text = tree.get(p);
      if (oldText.length === 0) {
        if (text !== null) throw new Fail('exists', p);
        tree.now.set(p, newText.length === 0 ? '' : newText.join('\n') + '\n');
        return;
      }
      if (text === null) throw new Fail('missing', p);
      const f = splitFile(text);
      const o: OLine[] = oldText.map((t) => ({ text: t, ctx: false }));
      const n: NLine[] = newText.map((t) => ({ text: t, ctx: false }));
      const found = findOccurrences(f.lines, oldText, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const rep = buildReplacement(o, n, f.lines, at, found.tier);
      f.lines.splice(at, oldText.length, ...rep);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveNew = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      moveNew.set(newP, oldP);
    }
  }
  const moveOlds = new Set(moveNew.values());
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: string[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNew.has(p)) rows.push(`R ${moveNew.get(p)} -> ${p}`);
    else if (moveOlds.has(p)) continue;
    else rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
