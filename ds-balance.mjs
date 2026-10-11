#!/usr/bin/env node
/**
 * ds-balance — DeepSeek API Key 余额查询工具
 *
 * 零依赖（Node.js >= 18，使用内置 fetch）。两种用法：
 *   1. 命令行：node ds-balance.mjs
 *   2. 本地网页：node ds-balance.mjs --serve
 *
 * 接口依据官方文档 GET https://api.deepseek.com/user/balance
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(ROOT, 'ui.html');
const DATA_DIR = process.env.DS_BALANCE_HOME
  ? path.resolve(process.env.DS_BALANCE_HOME)
  : path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'keys.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

const VERSION = '1.1.0';
const DEFAULT_BASE_URL = process.env.DS_BALANCE_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_PORT = Number(process.env.DS_BALANCE_PORT || 8788);
const DEFAULT_TIMEOUT = 15000;

/** 余额完全没变且距上次记录不到这么久，就不重复写一条。 */
const DEDUPE_WINDOW_MS = 60 * 1000;

/* ────────────────────────────── 终端样式 ────────────────────────────── */

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code) => (text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const blue = paint('34');

/** 判断字符在终端里占 2 列（CJK 等全角字符）。 */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function strWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += WIDE.test(ch) ? 2 : 1;
  return width;
}

/** 按终端显示宽度右侧补空格（先补空格再上色，避免 ANSI 转义码干扰计算）。 */
function padEndW(text, width) {
  const gap = width - strWidth(text);
  return gap > 0 ? String(text) + ' '.repeat(gap) : String(text);
}

function truncateW(text, width) {
  let out = '';
  for (const ch of String(text)) {
    if (strWidth(out) + strWidth(ch) > width) return out + '…';
    out += ch;
  }
  return out;
}

/* ────────────────────────────── 数据存取 ────────────────────────────── */

async function loadStore() {
  let text;
  try {
    text = await readFile(STORE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, keys: [] };
    throw err;
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.keys)) {
      return { version: 1, ...parsed, keys: parsed.keys.filter((k) => k && typeof k.key === 'string') };
    }
    throw new Error('结构不符合预期');
  } catch (err) {
    // 存储文件损坏时先备份，绝不静默覆盖用户数据
    const backup = `${STORE_FILE}.corrupt-${Date.now()}.bak`;
    await rename(STORE_FILE, backup).catch(() => {});
    console.error(
      `${yellow('!')} 密钥文件无法解析（${err.message}），已备份到：\n  ${backup}\n  将重新创建空文件。`
    );
    return { version: 1, keys: [] };
  }
}

async function saveStore(store) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(STORE_FILE, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  await chmod(STORE_FILE, 0o600).catch(() => {});
}

/* ────────────────────────────── 查询记录 ──────────────────────────────
 *
 * 每次你主动查询余额，就把读数追加到 data/history.jsonl。
 * 相邻两次做差就是这段时间的消耗（余额下降）或充值（余额上升），
 * 网页版据此画出余额变化曲线和每日消耗柱状图。
 *
 * 网页版的 60 秒自动刷新不记录 —— 否则挂一天就是上千条噪声。
 * JSONL 追加写入，写一半断电也不会损坏已有数据。
 * -------------------------------------------------------------------- */

/** 读文件尾部若干字节，用于写入前去重，避免每次都全量读文件。 */
async function readTail(file, bytes = 16384) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (size === 0) return '';
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // 起始位置落在行中间时，丢掉被截断的首行
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** 从一次查询结果里提取要记录的读数。 */
function readingsFrom(keyId, result, at = new Date()) {
  if (!result?.ok) return [];
  return result.data.balances
    .filter((balance) => balance.total !== null)
    .map((balance) => ({
      ts: at.toISOString(),
      keyId,
      currency: balance.currency,
      total: balance.total,
      granted: balance.granted,
      toppedUp: balance.toppedUp,
    }));
}

/** 追加读数；余额没变且距上次记录不到 60 秒就跳过。返回实际写入条数。 */
async function recordReadings(readings) {
  if (!readings.length) return 0;

  const last = new Map();
  for (const line of (await readTail(HISTORY_FILE)).split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      last.set(`${item.keyId}|${item.currency}`, item);
    } catch { /* 坏行跳过 */ }
  }

  const now = Date.now();
  const fresh = readings.filter((reading) => {
    const previous = last.get(`${reading.keyId}|${reading.currency}`);
    if (!previous) return true;
    const unchanged = previous.total === reading.total && previous.toppedUp === reading.toppedUp;
    return !unchanged || now - new Date(previous.ts).getTime() > DEDUPE_WINDOW_MS;
  });
  if (!fresh.length) return 0;

  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await appendFile(HISTORY_FILE, `${fresh.map((item) => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
  await chmod(HISTORY_FILE, 0o600).catch(() => {});
  return fresh.length;
}

/** 读取全部读数，坏行跳过，按时间升序。 */
async function loadHistory() {
  let text;
  try {
    text = await readFile(HISTORY_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (typeof item?.total === 'number' && item.ts && item.currency) items.push(item);
    } catch { /* 坏行跳过 */ }
  }
  items.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return items;
}

async function clearHistory() {
  await unlink(HISTORY_FILE).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** 查询余额，并把结果记进历史。record 为 false 时只查不记（自动刷新用）。 */
async function queryAndRecord(keyId, key, options = {}) {
  const result = await queryBalance(key, options);
  if (keyId && options.record !== false) {
    try {
      await recordReadings(readingsFrom(keyId, result));
    } catch (err) {
      if (!options.quiet) console.error(`${yellow('!')} 查询记录写入失败：${err.message}`);
    }
  }
  return result;
}

/* ────────────────────────────── 记录统计 ────────────────────────────── */

function localDayKey(date) {
  const d = new Date(date);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function addInto(target, currency, amount) {
  target[currency] = (target[currency] ?? 0) + amount;
}

/**
 * 把读数整理成网页界面要的画图数据。
 * 相邻两条读数的差：下降 = 消耗，上升 = 充值或赠金到账。
 */
function computeHistory(readings, { days = 30, now = new Date() } = {}) {
  const groups = new Map();
  for (const item of readings) {
    const groupKey = `${item.keyId}|${item.currency}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { keyId: item.keyId ?? null, currency: item.currency, points: [] });
    }
    groups.get(groupKey).points.push({ ts: new Date(item.ts), total: item.total });
  }

  const series = [];
  const events = [];
  for (const group of groups.values()) {
    group.points.sort((a, b) => a.ts - b.ts);
    series.push(group);
    for (let i = 1; i < group.points.length; i += 1) {
      const delta = group.points[i].total - group.points[i - 1].total;
      if (Math.abs(delta) < 0.0001) continue;
      events.push({
        ts: group.points[i].ts,
        keyId: group.keyId,
        currency: group.currency,
        type: delta < 0 ? 'spend' : 'topup',
        amount: Math.abs(delta),
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const nowMs = now.getTime();
  const spend = {};
  const topup = {};
  for (const event of events) {
    addInto(event.type === 'spend' ? spend : topup, event.currency, event.amount);
  }

  const current = {};
  for (const group of series) {
    const lastPoint = group.points[group.points.length - 1];
    if (lastPoint) addInto(current, group.currency, lastPoint.total);
  }

  // 柱状图用的连续日序列
  const byDay = new Map();
  for (const event of events) {
    const key = localDayKey(event.ts);
    if (!byDay.has(key)) byDay.set(key, { date: key, spend: {}, topup: {} });
    addInto(event.type === 'spend' ? byDay.get(key).spend : byDay.get(key).topup, event.currency, event.amount);
  }
  const calendar = [];
  if (readings.length) {
    const firstDay = localDayKey(readings[0].ts);
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(nowMs - i * 86400000);
      const key = localDayKey(date);
      // 开始记录之前的日子是「未知」而不是「没消耗」，不画
      if (key < firstDay) continue;
      const bucket = byDay.get(key);
      calendar.push({ date: key, spend: bucket?.spend ?? {}, topup: bucket?.topup ?? {} });
    }
  }

  const first = readings.length ? new Date(readings[0].ts) : null;
  const last = readings.length ? new Date(readings[readings.length - 1].ts) : null;

  return {
    series: series.map((group) => ({
      keyId: group.keyId,
      currency: group.currency,
      points: group.points.map((point) => ({ ts: point.ts.toISOString(), total: point.total })),
    })),
    events: events.slice(-200).reverse(),
    calendar,
    current,
    days,
    summary: {
      readings: readings.length,
      first: first ? first.toISOString() : null,
      last: last ? last.toISOString() : null,
      spanHours: first && last ? (last - first) / 3600000 : 0,
      spend,
      topup,
    },
  };
}

/* ────────────────────────────── 工具函数 ────────────────────────────── */

/** 清洗粘贴进来的密钥：去掉引号、Bearer 前缀和空白。 */
function normalizeKey(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '')
    .trim();
}

/** sk-abcdef...1234 → sk-••••••1234 */
function maskKey(key) {
  const k = String(key ?? '');
  if (k.length <= 8) return '•'.repeat(Math.max(k.length, 4));
  return `${k.slice(0, 3)}${'•'.repeat(6)}${k.slice(-4)}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function currencySymbol(currency) {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

function formatAmount(value, currency) {
  if (value === null) return '—';
  // 金额统一保留两位小数，保证 CLI 与网页版显示一致
  return `${currencySymbol(currency)}${value.toFixed(2)}`;
}

/* ────────────────────────────── 余额查询 ────────────────────────────── */

function describeHttpError(status, message) {
  const detail = message ? `（${message}）` : '';
  if (status === 401) return `密钥无效或已被撤销${detail}。请确认复制完整、没有多余空格，或到 platform.deepseek.com 重新生成。`;
  if (status === 402) return `账户余额不足，接口已拒绝调用${detail}。请前往 platform.deepseek.com 充值。`;
  if (status === 403) return `该密钥没有访问权限${detail}。`;
  if (status === 404) return `接口地址不存在${detail}。请检查 --base-url 是否指向了正确的网关。`;
  if (status === 429) return `请求过于频繁${detail}。请稍后重试。`;
  if (status >= 500) return `DeepSeek 服务端异常 HTTP ${status}${detail}。稍后重试即可。`;
  return `请求失败 HTTP ${status}${detail}。`;
}

/**
 * 查询单个密钥余额。
 * @returns {Promise<{ok:boolean,status:number,latencyMs:number,error?:string,data?:object,raw?:unknown}>}
 */
async function queryBalance(key, { baseUrl = DEFAULT_BASE_URL, timeout = DEFAULT_TIMEOUT } = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/user/balance`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    const latencyMs = Date.now() - started;

    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null; // 例如未鉴权时返回的纯文本 "Authentication Fails (governor)"
    }

    if (!res.ok) {
      const message = body?.error?.message || text.trim().slice(0, 200) || '';
      return { ok: false, status: res.status, latencyMs, error: describeHttpError(res.status, message), raw: body ?? text };
    }

    if (!body || typeof body !== 'object') {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: `接口返回了非 JSON 内容，可能被代理或网关拦截：${text.trim().slice(0, 120)}`,
        raw: text,
      };
    }

    const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
    return {
      ok: true,
      status: res.status,
      latencyMs,
      data: {
        isAvailable: body.is_available !== false,
        balances: infos.map((info) => ({
          currency: String(info?.currency ?? ''),
          total: toNumber(info?.total_balance),
          granted: toNumber(info?.granted_balance),
          toppedUp: toNumber(info?.topped_up_balance),
        })),
        raw: body,
      },
      raw: body,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { ok: false, status: 0, latencyMs, error: `请求超时（${Math.round(timeout / 1000)} 秒）。请检查网络后重试。` };
    }
    return {
      ok: false,
      status: 0,
      latencyMs,
      error: `无法连接 ${endpoint}：${err.message}。请检查网络；若走自建网关，用 --base-url 指定地址。`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────── CLI 输出 ────────────────────────────── */

function renderResult({ name, masked, result }) {
  const lines = [];
  const statusText = result.ok
    ? result.data.isAvailable
      ? green('✓ 可正常调用')
      : yellow('! 余额不足，接口将拒绝调用')
    : red('✗ 查询失败');

  const head = `  ${bold(name)} ${dim(masked)}`;
  lines.push(`${head}  ${dim(`${result.latencyMs} ms`)}`);
  lines.push(`    ${padEndW('状态', 10)}${statusText}`);

  if (result.ok) {
    const { balances } = result.data;
    if (balances.length === 0) {
      lines.push(`    ${padEndW('余额明细', 10)}${dim('接口未返回任何币种明细')}`);
    } else {
      balances.forEach((b, index) => {
        const label = index === 0 ? '可用余额' : '';
        lines.push(`    ${padEndW(label, 10)}${bold(formatAmount(b.total, b.currency))}`);
        const parts = [];
        if (b.granted !== null) parts.push(`赠金 ${formatAmount(b.granted, b.currency)}`);
        if (b.toppedUp !== null) parts.push(`充值 ${formatAmount(b.toppedUp, b.currency)}`);
        if (parts.length) lines.push(`    ${padEndW('', 10)}${dim(parts.join('  ·  '))}`);
      });
    }
  } else {
    const wrapped = wrapText(result.error, 64);
    wrapped.forEach((line, index) => {
      lines.push(`    ${padEndW(index === 0 ? '错误' : '', 10)}${red(line)}`);
    });
  }

  return lines.join('\n');
}

/** 中文避头点：这些符号不应出现在行首。 */
const NO_LINE_START = /[。，、；：？！）】》」』”’%…·]/;

function wrapText(text, width) {
  const lines = [];
  let current = '';
  for (const ch of String(text)) {
    const overflow = strWidth(current) + strWidth(ch) > width;
    if (overflow && current && !NO_LINE_START.test(ch)) {
      lines.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function summarizeTotals(entries) {
  const totals = new Map();
  for (const { result } of entries) {
    if (!result.ok) continue;
    for (const b of result.data.balances) {
      if (b.total === null) continue;
      totals.set(b.currency, (totals.get(b.currency) ?? 0) + b.total);
    }
  }
  return [...totals.entries()].map(([currency, total]) => ({ currency, total }));
}

function printBanner() {
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date());
  console.log('');
  console.log(`${bold('DeepSeek 余额')}  ${dim(stamp)}`);
  console.log('');
}

function toJsonResults(entries, extras = {}) {
  return {
    generatedAt: new Date().toISOString(),
    baseUrl: extras.baseUrl ?? DEFAULT_BASE_URL,
    results: entries.map(({ id, name, masked, result }) => ({
      id: id ?? null,
      name,
      masked,
      ok: result.ok,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
      isAvailable: result.ok ? result.data.isAvailable : null,
      balances: result.ok ? result.data.balances.map(({ currency, total, granted, toppedUp }) => ({ currency, total, granted, toppedUp })) : [],
    })),
    totals: summarizeTotals(entries),
  };
}

/* ────────────────────────────── 交互输入 ────────────────────────────── */

/** 终端里隐藏回显地读取密钥。非 TTY 时退回普通读取（便于管道）。 */
function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data.trim()));
    });
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          return reject(new Error('已取消'));
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        process.stdout.write('•');
      }
    };

    stdin.on('data', onData);
  });
}

function readLine(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
  });
}

/* ────────────────────────────── 本地 Web 服务 ────────────────────────────── */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 整理成对外的扁平结构，屏蔽内部 raw 原文。
 * 形状：{ id, name, masked, createdAt, ok, status, latencyMs, error, isAvailable, balances }
 * CLI --json 与网页界面共用同一套字段。
 */
function toWire({ id = null, name, masked, createdAt = null, ...result }) {
  return {
    id,
    name,
    masked,
    createdAt,
    ok: Boolean(result.ok),
    status: result.status ?? 0,
    latencyMs: result.latencyMs ?? 0,
    error: result.error ?? null,
    isAvailable: result.ok ? result.data.isAvailable : null,
    balances: result.ok ? result.data.balances : [],
  };
}

function publicKey(entry) {
  return { id: entry.id, name: entry.name, masked: maskKey(entry.key), createdAt: entry.createdAt };
}

async function startServer({ port, baseUrl, timeout, open }) {
  let html;
  try {
    html = await readFile(UI_FILE, 'utf8');
  } catch {
    console.error(`${red('✗')} 找不到界面文件 ${UI_FILE}`);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    // 只服务本机：校验 Host，防止 DNS rebinding 把本地密钥接口暴露给外部域名
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) {
      return sendJson(res, 403, { error: '仅允许从本机访问' });
    }
    // 校验 Origin，阻止其他网页跨站调用本地接口
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = '';
      }
      if (!LOCAL_HOSTS.has(originHost)) {
        return sendJson(res, 403, { error: '跨站请求已被拒绝' });
      }
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const route = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && (route === '/' || route === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(html);
      }

      if (method === 'GET' && route === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      if (method === 'GET' && route === '/api/state') {
        const store = await loadStore();
        return sendJson(res, 200, {
          baseUrl,
          version: VERSION,
          storeFile: STORE_FILE,
          keys: store.keys.map(publicKey),
        });
      }

      if (method === 'POST' && route === '/api/keys') {
        const body = await readJsonBody(req);
        const key = normalizeKey(body.key);
        if (!key) return sendJson(res, 400, { error: '请填写 API Key' });
        if (key.length < 16) return sendJson(res, 400, { error: '这个 Key 看起来太短了，请检查是否复制完整' });

        const store = await loadStore();
        if (store.keys.some((entry) => entry.key === key)) {
          return sendJson(res, 409, { error: '这个 Key 已经保存过了' });
        }
        const name = String(body.name ?? '').trim() || `密钥 ${store.keys.length + 1}`;
        const entry = { id: randomUUID(), name, key, createdAt: new Date().toISOString() };
        store.keys.push(entry);
        await saveStore(store);
        return sendJson(res, 201, { key: publicKey(entry) });
      }

      const keyRoute = route.match(/^\/api\/keys\/([\w-]+)$/);
      if (keyRoute && method === 'DELETE') {
        const store = await loadStore();
        const before = store.keys.length;
        store.keys = store.keys.filter((entry) => entry.id !== keyRoute[1]);
        if (store.keys.length === before) return sendJson(res, 404, { error: '找不到这个密钥' });
        await saveStore(store);
        return sendJson(res, 200, { ok: true });
      }

      // 查询单个已保存密钥
      if (method === 'POST' && route === '/api/query') {
        const body = await readJsonBody(req);
        const store = await loadStore();
        const entry = store.keys.find((item) => item.id === body.id);
        if (!entry) return sendJson(res, 404, { error: '找不到这个密钥' });
        const result = await queryAndRecord(entry.id, entry.key, {
          baseUrl, timeout, record: body.record !== false,
        });
        return sendJson(res, 200, toWire({ ...publicKey(entry), ...result }));
      }

      // 查询未保存的临时密钥（不落盘，也不记录）
      if (method === 'POST' && route === '/api/query-raw') {
        const body = await readJsonBody(req);
        const key = normalizeKey(body.key);
        if (!key) return sendJson(res, 400, { error: '请填写 API Key' });
        const result = await queryBalance(key, { baseUrl, timeout });
        return sendJson(res, 200, toWire({ id: null, name: '临时查询', masked: maskKey(key), ...result }));
      }

      // 并发查询全部已保存密钥。自动刷新时传 record:false，免得挂一天刷出上千条记录
      if (method === 'POST' && route === '/api/query-all') {
        const body = await readJsonBody(req);
        const record = body.record !== false;
        const store = await loadStore();
        const results = await Promise.all(
          store.keys.map(async (entry) => {
            const result = await queryAndRecord(entry.id, entry.key, { baseUrl, timeout, record });
            return toWire({ ...publicKey(entry), ...result });
          })
        );
        return sendJson(res, 200, { results });
      }

      // 查询记录与画图数据
      if (method === 'GET' && route === '/api/history') {
        const requested = Number(url.searchParams.get('days'));
        const days = Number.isFinite(requested) && requested > 0 ? Math.min(Math.round(requested), 365) : 30;
        const [readings, store] = await Promise.all([loadHistory(), loadStore()]);
        const history = computeHistory(readings, { days });
        history.keys = store.keys.map(publicKey);
        return sendJson(res, 200, history);
      }

      // 清空记录（需要显式确认，避免误触）
      if (method === 'DELETE' && route === '/api/history') {
        const body = await readJsonBody(req);
        if (body.confirm !== true) return sendJson(res, 400, { error: '需要确认后才能清空' });
        await clearHistory();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: '接口不存在' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || '服务器内部错误' });
    }
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (candidate) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < 10) {
          attempt += 1;
          tryListen(candidate + 1);
        } else {
          reject(err);
        }
      });
      server.listen(candidate, '127.0.0.1', () => resolve({ server, port: candidate }));
    };
    tryListen(port);
  });
}

/* ────────────────────────────── 帮助 ────────────────────────────── */

const HELP = `
${bold('ds-balance')} — DeepSeek API Key 余额查询工具  ${dim(`v${VERSION}`)}

${bold('用法')}
  node ds-balance.mjs                    查询所有已保存的密钥
  node ds-balance.mjs sk-xxxxxxxx        临时查询一个密钥（不保存）
  node ds-balance.mjs --add 主账号        保存一个密钥（会隐藏回显地提示输入）
  node ds-balance.mjs --list             列出已保存的密钥
  node ds-balance.mjs --remove 主账号     删除一个密钥
  node ds-balance.mjs --history          查看查询记录与消耗明细
  node ds-balance.mjs --serve            打开本地网页版界面

${bold('选项')}
  -k, --key <sk-...>     直接提供密钥，跳过交互输入
      --name <名称>       配合 --add 指定名称
      --json             以 JSON 输出，方便脚本调用
      --no-record        这次查询不写进历史记录
  -y, --yes              跳过删除、清空等确认
      --port <端口>       网页版端口（默认 ${DEFAULT_PORT}）
      --open             启动网页版后自动打开浏览器
      --base-url <地址>   接口地址（默认 ${DEFAULT_BASE_URL}）
      --timeout <毫秒>    单次请求超时（默认 ${DEFAULT_TIMEOUT}）
  -h, --help             显示帮助
  -v, --version          显示版本

${bold('环境变量')}
  DS_BALANCE_BASE_URL   覆盖接口地址
  DS_BALANCE_HOME       密钥存储目录（默认 ./data）
  DS_BALANCE_PORT       默认端口
  NO_COLOR              设为任意值可关闭彩色输出

${bold('数据位置')}
  ${STORE_FILE}    ${dim('密钥，权限 600')}
  ${HISTORY_FILE}  ${dim('查询记录，权限 600')}

${bold('查询记录')}
  每次主动查询余额都会记一条（网页版的 60 秒自动刷新不记）。
  相邻两条做差就是这段时间的消耗或充值，网页版据此画出余额曲线和每日消耗。
`;

/* ────────────────────────────── 参数解析 ────────────────────────────── */

function parseArgs(argv) {
  const opts = {
    mode: 'query',
    key: null,
    name: null,
    target: null,
    json: false,
    yes: false,
    open: false,
    port: DEFAULT_PORT,
    baseUrl: DEFAULT_BASE_URL,
    timeout: DEFAULT_TIMEOUT,
    record: true,
    limit: 20,
    positionals: [],
  };

  const need = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要一个值`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.mode = 'help';
        break;
      case '-v':
      case '--version':
        opts.mode = 'version';
        break;
      case '--serve':
        opts.mode = 'serve';
        break;
      case '--history':
        opts.mode = 'history';
        if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) opts.limit = Number(argv[++i]);
        break;
      case '--clear-history':
        opts.mode = 'clearHistory';
        break;
      case '--no-record':
        opts.record = false;
        break;
      case '--list':
        opts.mode = 'list';
        break;
      case '--add':
        opts.mode = 'add';
        break;
      case '--remove':
      case '--rm':
        opts.mode = 'remove';
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.target = argv[++i];
        break;
      case '-k':
      case '--key':
        opts.key = need(i, arg);
        i += 1;
        break;
      case '--name':
        opts.name = need(i, arg);
        i += 1;
        break;
      case '--port':
        opts.port = Number(need(i, arg));
        i += 1;
        break;
      case '--base-url':
        opts.baseUrl = need(i, arg);
        i += 1;
        break;
      case '--timeout':
        opts.timeout = Number(need(i, arg));
        i += 1;
        break;
      case '--json':
        opts.json = true;
        break;
      case '-y':
      case '--yes':
        opts.yes = true;
        break;
      case '--open':
        opts.open = true;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`未知选项 ${arg}`);
        opts.positionals.push(arg);
    }
  }

  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error('--port 必须是有效端口号');
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout 必须是毫秒数');

  if (opts.mode === 'query' && opts.positionals.length > 0) {
    opts.key = opts.positionals[0];
  }
  // --add 主账号 这样的写法：位置参数当作名称
  if (opts.mode === 'add' && !opts.name && opts.positionals.length > 0) {
    opts.name = opts.positionals[0];
  }
  return opts;
}

/* ────────────────────────────── 各命令实现 ────────────────────────────── */

async function cmdQuery(opts) {
  const { baseUrl, timeout } = opts;

  // 临时查询：不走存储
  if (opts.key) {
    const key = normalizeKey(opts.key);
    if (!key) throw new Error('密钥为空');
    const result = await queryBalance(key, { baseUrl, timeout });
    const entry = { id: null, name: '临时查询', masked: maskKey(key), result };

    if (opts.json) {
      console.log(JSON.stringify(toJsonResults([entry], { baseUrl }), null, 2));
    } else {
      printBanner();
      console.log(renderResult(entry));
      console.log('');
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const store = await loadStore();
  if (store.keys.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ ...toJsonResults([], { baseUrl }), results: [] }, null, 2));
      return;
    }
    console.log('');
    console.log(`${yellow('●')} 还没有保存任何密钥。`);
    console.log(`  添加一个：  ${bold('node ds-balance.mjs --add 主账号')}`);
    console.log(`  打开网页版：${bold('node ds-balance.mjs --serve')}`);
    console.log('');
    return;
  }

  const entries = await Promise.all(
    store.keys.map(async (item) => ({
      id: item.id,
      name: item.name,
      masked: maskKey(item.key),
      result: await queryAndRecord(item.id, item.key, { baseUrl, timeout, record: opts.record }),
    }))
  );

  if (opts.json) {
    console.log(JSON.stringify(toJsonResults(entries, { baseUrl }), null, 2));
  } else {
    printBanner();
    for (const entry of entries) {
      console.log(renderResult(entry));
      console.log('');
    }
    const totals = summarizeTotals(entries);
    if (totals.length > 0) {
      const text = totals.map((t) => formatAmount(t.total, t.currency)).join('  +  ');
      console.log(`  ${dim('合计可用余额')}  ${bold(text)}`);
      console.log('');
    }
  }

  process.exitCode = entries.some((entry) => !entry.result.ok) ? 1 : 0;
}

async function cmdAdd(opts) {
  let raw = opts.key;
  if (!raw) {
    raw = await readSecret('粘贴 API Key（输入时不显示，回车确认）：');
  }
  const key = normalizeKey(raw);
  if (!key) throw new Error('密钥为空，未保存');
  if (key.length < 16) throw new Error('这个 Key 看起来太短了，请检查是否复制完整');
  if (!key.startsWith('sk-')) {
    console.log(`${yellow('!')} 这个 Key 不以 sk- 开头，仍然按原样使用。`);
  }

  const store = await loadStore();
  if (store.keys.some((entry) => entry.key === key)) throw new Error('这个 Key 已经保存过了');

  const name = opts.name || (await readLine(`给它起个名字（回车用「密钥 ${store.keys.length + 1}」）：`)) || `密钥 ${store.keys.length + 1}`;
  const entry = { id: randomUUID(), name, key, createdAt: new Date().toISOString() };
  store.keys.push(entry);
  await saveStore(store);

  console.log('');
  console.log(`${green('✓')} 已保存 ${bold(name)} ${dim(maskKey(key))}`);
  console.log(`  ${dim(`存储于 ${STORE_FILE}`)}`);

  const result = await queryAndRecord(entry.id, key, { ...opts, record: opts.record });
  console.log('');
  console.log(renderResult({ name, masked: maskKey(key), result }));
  console.log('');
  process.exitCode = result.ok ? 0 : 1;
}

async function cmdList(opts) {
  const store = await loadStore();
  if (store.keys.length === 0) {
    console.log(`\n${yellow('●')} 还没有保存任何密钥。\n`);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(store.keys.map(publicKey), null, 2));
    return;
  }
  console.log('');
  store.keys.forEach((entry, index) => {
    // 先按纯文本补空格再上色，否则 ANSI 转义码会破坏列对齐
    console.log(`  ${String(index + 1).padStart(2)}. ${bold(padEndW(entry.name, 24))}${dim(maskKey(entry.key))}`);
  });
  console.log(`\n  ${dim(`${store.keys.length} 个密钥 · ${STORE_FILE}`)}\n`);
}

async function cmdHistory(opts) {
  const [readings, store] = await Promise.all([loadHistory(), loadStore()]);
  const history = computeHistory(readings);

  if (opts.json) {
    console.log(JSON.stringify({ ...history, historyFile: HISTORY_FILE }, null, 2));
    return;
  }

  if (!readings.length) {
    console.log('');
    console.log(`${yellow('●')} 还没有查询记录。`);
    console.log('');
    console.log('  每次你主动查询余额都会自动记一条，攒几条之后：');
    console.log(`    ${bold('node ds-balance.mjs --history')}   ${dim('看记录')}`);
    console.log(`    ${bold('node ds-balance.mjs --serve')}     ${dim('看图表')}`);
    console.log('');
    return;
  }

  const names = new Map(store.keys.map((entry) => [entry.id, entry.name]));
  const label = (id) => names.get(id) ?? (id ? id.slice(0, 8) : '已删除的密钥');
  const { summary } = history;
  const timeFmt = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  console.log('');
  console.log(`${bold('查询记录')}  ${dim(`${summary.readings} 条`)}`);
  console.log('');
  history.events.slice(0, opts.limit).forEach((event) => {
    const when = timeFmt.format(new Date(event.ts));
    const amount = formatAmount(event.amount, event.currency);
    const text = event.type === 'spend' ? `${red('-')}${amount}` : `${green('+')}${amount}`;
    const kind = event.type === 'spend' ? '消耗' : '充值';
    console.log(`  ${dim(when)}  ${padEndW(kind, 6)}${padEndW(text, 14)}${dim(label(event.keyId))}`);
  });

  const spend = formatMoneyMap(summary.spend);
  const topup = formatMoneyMap(summary.topup);
  console.log('');
  if (spend) console.log(`  ${padEndW('期间消耗', 12)}${spend}`);
  if (topup) console.log(`  ${padEndW('期间充值', 12)}${green(`+${topup}`)}`);
  if (!spend && !topup) console.log(`  ${dim('期间余额没有变化')}`);
  console.log(`  ${dim(`记录文件 ${HISTORY_FILE}`)}`);
  console.log('');
}

/** {CNY: 3.4} → "¥3.40"，空对象返回 null。 */
function formatMoneyMap(map) {
  const parts = Object.entries(map ?? {})
    .filter(([, amount]) => Math.abs(amount) >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([currency, amount]) => formatAmount(amount, currency));
  return parts.length ? parts.join('  +  ') : null;
}

async function cmdRemove(opts) {
  const store = await loadStore();
  const target = opts.target ?? opts.name ?? opts.positionals[0];
  if (!target) throw new Error('请指定要删除的名称或序号，例如 --remove 主账号');
  if (store.keys.length === 0) throw new Error('还没有保存任何密钥');

  let index = store.keys.findIndex((entry) => entry.id === target || entry.name === target);
  if (index === -1 && /^\d+$/.test(target)) {
    const position = Number(target) - 1;
    if (position >= 0 && position < store.keys.length) index = position;
  }
  if (index === -1) throw new Error(`找不到「${target}」`);

  const entry = store.keys[index];
  if (!opts.yes) {
    const answer = await readLine(`确认删除 ${entry.name}（${maskKey(entry.key)}）？输入 y 确认：`);
    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('已取消，未做任何改动。');
      return;
    }
  }

  store.keys.splice(index, 1);
  await saveStore(store);
  console.log(`${green('✓')} 已删除 ${bold(entry.name)} ${dim(maskKey(entry.key))}`);
}

/* ────────────────────────────── 服务 ────────────────────────────── */

async function cmdServe(opts) {
  const { server, port } = await startServer(opts);
  const url = `http://127.0.0.1:${port}`;
  if (opts.port !== port) {
    console.log(`${yellow('!')} 端口 ${opts.port} 被占用，已改用 ${port}`);
  }
  console.log('');
  console.log(`${bold('DeepSeek 余额')} 网页版已启动`);
  console.log(`  ${blue(url)}`);
  console.log(`  ${dim(`接口 ${opts.baseUrl} · 存储 ${STORE_FILE}`)}`);
  console.log(`  ${dim('按 Ctrl+C 停止')}`);
  console.log('');

  if (opts.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  }

  const shutdown = () => {
    console.log(`\n${dim('已停止。')}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ────────────────────────────── 入口 ────────────────────────────── */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${red('✗')} ${err.message}\n\n运行 node ds-balance.mjs --help 查看用法。`);
    process.exit(2);
  }

  try {
    switch (opts.mode) {
      case 'help':
        console.log(HELP);
        return;
      case 'version':
        console.log(VERSION);
        return;
      case 'serve':
        await cmdServe(opts);
        return;
      case 'list':
        await cmdList(opts);
        return;
      case 'add':
        await cmdAdd(opts);
        return;
      case 'remove':
        await cmdRemove(opts);
        return;
      case 'history':
        await cmdHistory(opts);
        return;
      case 'clearHistory': {
        if (!opts.yes) {
          const answer = await readLine('确认清空全部查询记录？密钥和余额不受影响，但历史图表会消失。输入 y 确认：');
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('已取消，未做任何改动。');
            return;
          }
        }
        await clearHistory();
        console.log(`${green('✓')} 查询记录已清空`);
        return;
      }
      default:
        await cmdQuery(opts);
    }
  } catch (err) {
    console.error(`${red('✗')} ${err.message}`);
    process.exit(1);
  }
}

main();
