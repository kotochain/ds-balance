#!/usr/bin/env node
/**
 * 密钥泄露检查。
 *
 * 这个工具的设计前提是：**只上传工具，密钥和记录永远留在本机**。
 * 这个脚本就是把这个前提用机器锁死，而不是靠人记得小心。
 *
 * 三种模式：
 *   node tests/check-secrets.mjs            扫描仓库里被 git 跟踪的文件（默认）
 *   node tests/check-secrets.mjs --staged   只扫暂存区，pre-commit 钩子用
 *   node tests/check-secrets.mjs --history  扫全部提交历史
 *
 * 发现可疑内容时退出码为 1。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：URL.pathname 是百分号编码的，
// 路径里带空格或中文（比如本项目目录 "ds key"）时会指向不存在的目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(ROOT, 'ds-balance.mjs'))) {
  // 宁可直接报错，也不要因为找不到目录而静默放行
  console.error(`\u001b[31m✗\u001b[0m 定位不到项目根目录：${ROOT}`);
  process.exit(2);
}

/** 常见密钥的形态。宁可多报也不能漏报，误报可以加白名单。 */
const PATTERNS = [
  { name: 'API 密钥（sk- 开头）', re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: '私钥内容', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** 这些路径一旦被 git 跟踪就是事故，不看内容直接拦。 */
const FORBIDDEN_PATHS = [
  { name: '本机数据目录', re: /(^|\/)data\// },
  { name: '密钥文件', re: /(^|\/)keys\.json$/ },
  { name: '查询记录', re: /(^|\/)history\.jsonl$/ },
  { name: '环境变量文件', re: /(^|\/)\.env(\.|$)/ },
  { name: '证书私钥', re: /\.(pem|key|p12|pfx)$/i },
  { name: 'SSH 私钥', re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/ },
  { name: '凭据文件', re: /(^|\/)credentials(\.|$)/i },
];

/** 已知的假密钥（测试里用的），扫到就跳过。 */
const KNOWN_FAKE = new Set([
  'sk-a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
  'sk-e5f6a7b8e5f6a7b8e5f6a7b8e5f6a7b8',
  'sk-0000000000000000000000000000dead',
  'sk-0000000000000000000000000000beef',
]);

/** 单行放行标记，用在确实需要写示例密钥的地方 */
const ALLOW_MARK = 'check-secrets:allow';

function git(args) {
  // core.quotepath=false：否则中文文件名会被转义成 "\345\220..."，读不到文件
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function scanText(text, label, findings) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARK)) return;
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        if (KNOWN_FAKE.has(match[0])) continue;
        // 只显示前后几位，避免把命中的密钥又打印出来
        const hit = `${match[0].slice(0, 6)}…${match[0].slice(-2)}`;
        findings.push({ label, line: index + 1, kind: name, hit });
      }
    }
  });
}

function checkPaths(files, findings) {
  for (const file of files) {
    for (const { name, re } of FORBIDDEN_PATHS) {
      if (re.test(file)) findings.push({ label: file, line: 0, kind: name, hit: '路径本身不该被提交' });
    }
  }
}

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function runTree() {
  const files = git(['ls-files']).split('\n').filter(Boolean);
  const findings = [];
  const skipped = [];
  checkPaths(files, findings);

  for (const file of files) {
    const full = path.join(ROOT, file);
    let content;
    try {
      if (statSync(full).size > MAX_SCAN_BYTES) {
        skipped.push(`${file}（超过 ${MAX_SCAN_BYTES / 1024 / 1024}MB）`);
        continue;
      }
      content = readFileSync(full, 'utf8');
    } catch (err) {
      // 读不到就说出来，绝不静默放过
      skipped.push(`${file}（${err.code ?? err.message}）`);
      continue;
    }
    if (content.includes('\u0000')) {
      skipped.push(`${file}（二进制）`);
      continue;
    }
    scanText(content, file, findings);
  }
  return { findings, scanned: files.length, skipped };
}

function runStaged() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .filter(Boolean);
  const findings = [];
  const skipped = [];
  checkPaths(files, findings);

  for (const file of files) {
    let content;
    try {
      content = git(['show', `:${file}`]);
    } catch (err) {
      skipped.push(`${file}（${err.code ?? 'git show 失败'}）`);
      continue;
    }
    if (content.includes('\u0000')) {
      skipped.push(`${file}（二进制）`);
      continue;
    }
    scanText(content, file, findings);
  }
  return { findings, scanned: files.length, skipped };
}

function runHistory() {
  const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
  const findings = [];
  if (!revs.length) return { findings, scanned: 0, skipped: [] };

  for (const { name, re } of PATTERNS) {
    let out = '';
    try {
      out = git(['grep', '-I', '-n', '-E', '-e', re.source, ...revs]);
    } catch (err) {
      // git grep 无匹配时退出码为 1；其余错误必须暴露，绝不静默跳过
      if (err.status === 1) continue;
      throw new Error(`git grep 执行失败（${name}）：${String(err.stderr || err.message).trim()}`);
    }
    for (const line of out.split('\n')) {
      if (!line.trim() || line.includes(ALLOW_MARK)) continue;
      const hit = line.match(re);
      if (hit && KNOWN_FAKE.has(hit[0])) continue;
      const [rev, file, lineNo] = line.split(':');
      findings.push({ label: `${rev.slice(0, 8)}:${file}`, line: Number(lineNo) || 0, kind: name, hit: '历史提交里有疑似密钥' });
    }
  }

  const tracked = git(['log', '--all', '--name-only', '--pretty=format:']).split('\n').filter(Boolean);
  checkPaths([...new Set(tracked)], findings);
  return { findings, scanned: revs.length, skipped: [] };
}

const mode = process.argv.includes('--staged') ? 'staged'
  : process.argv.includes('--history') ? 'history'
  : 'tree';

const { findings, scanned, skipped = [] } = { staged: runStaged, history: runHistory, tree: runTree }[mode]();
const where = { staged: '暂存区', history: '提交历史', tree: '仓库跟踪的文件' }[mode];

if (!findings.length) {
  console.log(`\u001b[32m✓\u001b[0m 密钥检查通过（${where}，${scanned} 项）`);
  if (skipped.length) {
    console.log(`\u001b[33m!\u001b[0m 有 ${skipped.length} 项未做内容扫描：${skipped.join('、')}`);
  }
  process.exit(0);
}

console.error(`\u001b[31m✗\u001b[0m 密钥检查未通过（${where}），发现 ${findings.length} 处：\n`);
for (const f of findings) {
  console.error(`  ${f.label}${f.line ? `:${f.line}` : ''}  [${f.kind}]  ${f.hit}`);
}
console.error(`
密钥和查询记录应该只留在本机 data/ 目录里，不要提交进仓库。
  · 如果这是误报，在该行加注释 ${ALLOW_MARK} 即可放行
  · 如果确实提交了密钥，请立刻去 platform.deepseek.com 吊销并重新生成
`);
process.exit(1);
