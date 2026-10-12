#!/usr/bin/env node
/**
 * 自测脚本：用本地 mock 接口验证成功路径，不消耗真实额度。
 *
 *   node tests/self-test.mjs
 *
 * 覆盖：CLI 查询 / JSON / 增删查、Web 服务全部接口、Host 与 Origin 防护。
 */

import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { auditCssClasses } from './css-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'ds-balance.mjs');

const GOOD_KEY = `sk-${'a1b2c3d4'.repeat(4)}`;
const EMPTY_KEY = `sk-${'e5f6a7b8'.repeat(4)}`;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures.push(name);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/* ── 模拟 DeepSeek 接口（按官方文档的响应结构） ─────────────── */

function startMockApi() {
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const key = auth.replace(/^Bearer\s+/i, '');

    if (req.url !== '/user/balance' || req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Not Found' } }));
    }

    res.setHeader('Content-Type', 'application/json');

    const send = (status, payload) => {
      res.writeHead(status);
      res.end(JSON.stringify(payload));
    };

    if (key === GOOD_KEY) {
      return send(200, {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        ],
      });
    }
    if (key === EMPTY_KEY) {
      return send(200, {
        is_available: false,
        balance_infos: [
          { currency: 'CNY', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
        ],
      });
    }
    return send(401, {
      error: {
        message: `Authentication Fails, Your api key: ****${key.slice(-4)} is invalid (request_id: test-request)`,
        type: 'authentication_error',
        param: null,
        code: 'invalid_request_error',
      },
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ── 进程与请求辅助 ─────────────────────────────────────────── */

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startWebServer(port, env) {
  const child = spawn(process.execPath, [CLI, '--serve', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Web 服务启动超时')), 8000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('网页版已启动')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Web 服务提前退出，code=${code}`)));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function callJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, body, text };
}

/** fetch 会忽略 Host 头（属于禁止修改的请求头），这里用底层 http 模块发原始请求。 */
function rawGet(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * 极简 DOM 桩：让 ui.html 里真实的脚本能在 Node 里跑起来。
 * 只实现脚本实际用到的 API，元素由 ui.html 中的 id 自动发现。
 */
function makeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    type: 'password',
    className: '',
    disabled: false,
    style: {},
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    setAttribute(name, value) {
      this.attrs = this.attrs || {};
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return (this.attrs && Object.prototype.hasOwnProperty.call(this.attrs, name)) ? this.attrs[name] : null;
    },
    focus() {},
    reset() {},
    close() {},
    showModal() {},
    closest() { return null; },
  };
}

/** 用 ui.html 里的真实脚本 + 真实接口数据，验证界面渲染 */
async function runUiScript(origin) {
  const html = await readFile(path.join(ROOT, 'ui.html'), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('ui.html 里找不到内联脚本');

  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const elements = new Map(ids.map((id) => [id, makeElement(id)]));

  const context = vm.createContext({
    console,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: (input, options) => fetch(new URL(input, origin).toString(), options),
    document: {
      getElementById: (id) => elements.get(id) ?? null,
      addEventListener() {},
      visibilityState: 'visible',
    },
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      confirm: () => false,
      prompt: () => null,
      setInterval: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  });

  vm.runInContext(scriptMatch[1], context);
  return elements;
}

/** 在 DOM 桩上派发事件：把注册过的处理器挨个调一遍 */
function fire(element, type, extra = {}) {
  const handlers = (element.listeners && element.listeners[type]) || [];
  const event = Object.assign({ target: element, preventDefault() {}, stopPropagation() {} }, extra);
  handlers.forEach((handler) => handler(event));
  return handlers.length;
}

/** 轮询等待界面完成异步渲染 */
async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function checkUiRendering(origin) {
  const elements = await runUiScript(origin);
  const cards = () => elements.get('keyList').innerHTML;
  await waitFor(() => cards().includes('<article class="card'));

  const markup = cards();
  check('界面渲染出密钥卡片', markup.includes('<article class="card'), markup.slice(0, 200) || '(空)');
  check('卡片显示名称', markup.includes('主账号'), markup.slice(0, 300));
  check('卡片显示金额 110.00', markup.includes('110.00'), markup.slice(0, 300));
  check('卡片显示可调用状态', markup.includes('可正常调用'));
  check('卡片显示赠金与充值', markup.includes('赠金') && markup.includes('充值'));
  check('卡片显示掩码而非完整密钥', /sk-•+c3d4/.test(markup) && !markup.includes(GOOD_KEY));
  check('总览显示合计余额', elements.get('totalValue').innerHTML.includes('110.00'), elements.get('totalValue').innerHTML);
  check('总览显示密钥数量', elements.get('keyCount').textContent.includes('1 个'));
  check('错误卡片不会出现', !markup.includes('查询失败'), markup.slice(0, 300));
  check('占比条使用独立的类名', markup.includes('class="meter"') && !markup.includes('class="bar"'), markup.slice(0, 400));
}

/**
 * 造一段可精确断言的查询记录（相对当前时间生成，任何时间跑都成立）。
 *   100 起，逐日消耗 [4, 3, 0, 6, 2]，最后充值 25 → 期末 110.00
 *   累计消耗 15，累计充值 25
 *
 * 期末余额特意对齐 mock 返回的 110.00：界面启动时会自动查询一次并追加读数，
 * 余额相同则差值为 0，不会让断言依赖「追加发生在断言之前还是之后」。
 */
function buildReadings(keyId, now = new Date()) {
  const rows = [];
  const push = (date, total) => rows.push({
    ts: date.toISOString(), keyId, currency: 'CNY',
    total: Math.round(total * 100) / 100, granted: 0, toppedUp: Math.round(total * 100) / 100,
  });
  const at = (dayOffset, hour) => {
    const d = new Date(now);
    d.setHours(hour, 0, 0, 0);
    d.setDate(d.getDate() - dayOffset);
    return d;
  };

  let balance = 100;
  push(at(6, 9), balance);
  [4, 3, 0, 6, 2].forEach((spend, index) => {
    balance -= spend;
    push(at(5 - index, 10), balance);
  });
  balance += 25;
  push(at(0, 9), balance);

  return { rows, spend: 15, topup: 25, current: 110, days: 7 };
}

/** 空统计对象用：把读数写进指定目录并配一个密钥 */
async function seedHistory(dir, rows, keyId, key) {
  await writeFile(path.join(dir, 'history.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(
    path.join(dir, 'keys.json'),
    JSON.stringify({ version: 1, keys: [{ id: keyId, name: '主账号', key, createdAt: new Date().toISOString() }] }, null, 2)
  );
}

/** 查询记录视图：验证图表和统计真的画出来了 */
async function checkHistoryUiRendering(origin, expected) {
  const elements = await runUiScript(origin);
  const body = () => elements.get('historyBody').innerHTML;
  await waitFor(() => body().includes('<svg'));

  check('记录面板已显示', elements.get('historyPanel').hidden !== true);
  check('渲染出余额变化曲线', body().includes('path class="chart-line"') || /class="chart-line"/.test(body()), body().slice(0, 200));
  check('渲染出消耗柱状图', body().includes('class="chart-col"'), body().slice(0, 200));
  check('图表带无障碍描述', (body().match(/role="img" aria-label="[^"]+"/g) || []).length >= 2);
  check('统计卡显示当前余额', elements.get('historyBody').innerHTML.includes(expected.current.toFixed(2)),
    body().slice(0, 600));
  check('统计卡显示期间消耗', body().includes(expected.spend.toFixed(2)));
  check('统计卡显示期间充值', body().includes(expected.topup.toFixed(2)));
  check('列出最近的余额变化', body().includes('最近的余额变化') && body().includes('event-amount'));
  check('记录面板不泄露完整密钥', !body().includes(GOOD_KEY));

  // ── 悬停基础设施 ──
  check('图表包在可定位容器里', body().includes('class="chart-frame"'));
  check('容器带键盘入口', /class="chart-frame" data-chart="0" tabindex="0"/.test(body()));
  check('每个图表都有十字线/标记点/浮层',
    (body().match(/class="chart-cross"/g) || []).length >= 2 &&
    (body().match(/class="chart-marker"/g) || []).length >= 2 &&
    (body().match(/class="chart-tip"/g) || []).length >= 2);
  check('图表编号连续', body().includes('data-chart="0"') && body().includes('data-chart="1"'));
  check('悬停提示写在图表标题旁', body().includes('看每个节点的精确数值'));

  // ── 粒度切换 ──
  check('默认按天', elements.get('grainDay').getAttribute('aria-pressed') === 'true' &&
    elements.get('grainHour').getAttribute('aria-pressed') === 'false');

  const dayLabels = (body().match(/<text[^>]*text-anchor="middle">([^<]*)<\/text>/g) || []).join('');
  check('按天视图横轴是日期', /\d+\/\d+/.test(dayLabels), dayLabels.slice(0, 120));

  check('按小时按钮已绑定', fire(elements.get('grainHour'), 'click') === 1);
  check('切到按小时后状态翻转', elements.get('grainHour').getAttribute('aria-pressed') === 'true' &&
    elements.get('grainDay').getAttribute('aria-pressed') === 'false');

  const hourBody = body();
  const hourLabels = (hourBody.match(/<text[^>]*text-anchor="middle">([^<]*)<\/text>/g) || []).join('');
  check('按小时视图横轴出现整点', /\d{2}:00/.test(hourLabels), hourLabels.slice(0, 160));
  check('按小时视图仍画出曲线与柱子',
    hourBody.includes('class="chart-line"') && hourBody.includes('class="chart-col"'), hourBody.slice(0, 200));
  check('切换后图表编号重建', hourBody.includes('data-chart="0"'));

  check('按天按钮可切回', fire(elements.get('grainDay'), 'click') === 1 &&
    elements.get('grainDay').getAttribute('aria-pressed') === 'true');
}

const mock = await startMockApi();
const BASE = `http://127.0.0.1:${mock.port}`;
const home = await mkdtemp(path.join(tmpdir(), 'ds-balance-test-'));
// 默认把接口指向 mock，避免测试消耗真实额度
const env = { DS_BALANCE_HOME: home, DS_BALANCE_BASE_URL: BASE };

// 记录相关测试用的独立目录（自己写死读数，断言才精确）
const histHome = await mkdtemp(path.join(tmpdir(), 'ds-balance-hist-'));
const histEnv = { DS_BALANCE_HOME: histHome, DS_BALANCE_BASE_URL: BASE };
const HIST_KEY_ID = '33333333-3333-3333-3333-333333333333';
const fixture = buildReadings(HIST_KEY_ID);
let web = null;
let histWeb = null;

try {
  console.log(`\n\u001b[1mds-balance 自测\u001b[0m  mock=${BASE}  home=${home}`);

  section('CLI · 查询');
  {
    const r = await run(['--key', GOOD_KEY, '--base-url', BASE], env);
    check('退出码为 0', r.code === 0, `实际 ${r.code}\n${r.stderr}`);
    check('显示可用余额 ¥110.00', r.stdout.includes('¥110.00'), r.stdout);
    check('显示赠金与充值构成', r.stdout.includes('赠金') && r.stdout.includes('充值'));
    check('显示可调用状态', r.stdout.includes('可正常调用'));
    check('不泄露完整密钥', !r.stdout.includes(GOOD_KEY));
  }

  {
    const r = await run(['--key', EMPTY_KEY, '--base-url', BASE], env);
    check('余额为 0 时退出码仍为 0', r.code === 0, `实际 ${r.code}`);
    check('提示余额不足', r.stdout.includes('余额不足'), r.stdout);
  }

  {
    const r = await run(['--key', GOOD_KEY, '--base-url', BASE, '--json'], env);
    const parsed = JSON.parse(r.stdout);
    const item = parsed.results[0];
    check('JSON 可解析', Boolean(item));
    check('JSON 状态 ok', item?.ok === true);
    check('JSON 余额为 110', item?.balances?.[0]?.total === 110, JSON.stringify(item?.balances));
    check('JSON 合计正确', parsed.totals?.[0]?.total === 110, JSON.stringify(parsed.totals));
    check('返回耗时字段', typeof item?.latencyMs === 'number');
  }

  section('CLI · 密钥管理');
  let addedId = null;
  {
    const r = await run(['--add', '主账号', '--key', GOOD_KEY], env);
    check('添加成功', r.code === 0 && r.stdout.includes('已保存'), r.stdout + r.stderr);
    check('添加后立即查询到余额', r.stdout.includes('¥110.00'), r.stdout);
  }

  {
    const r = await run(['--add', '重复', '--key', GOOD_KEY], env);
    check('重复添加被拒绝', r.code === 1 && r.stderr.includes('已经保存过'), r.stderr);
  }

  {
    const r = await run(['--add', '太短', '--key', 'sk-123'], env);
    check('过短的密钥被拒绝', r.code === 1 && r.stderr.includes('太短'), r.stderr);
  }

  {
    const r = await run(['--list'], env);
    check('列表显示名称与掩码', r.stdout.includes('主账号') && /sk-•+/.test(r.stdout), r.stdout);
    check('列表不泄露完整密钥', !r.stdout.includes(GOOD_KEY));
  }

  {
    const r = await run(['--base-url', BASE], env);
    check('查询全部已保存密钥', r.code === 0 && r.stdout.includes('合计可用余额'), r.stdout);
  }

  {
    const r = await run(['--add', '--key', EMPTY_KEY], env);
    check('不指定名称时自动命名', r.code === 0 && r.stdout.includes('密钥 2'), r.stdout);

    const list = await run(['--list'], env);
    check('列表显示两个密钥', list.stdout.includes('2 个密钥'), list.stdout);

    const removed = await run(['--remove', '密钥 2', '--yes'], env);
    check('按名称删除密钥', removed.code === 0 && removed.stdout.includes('已删除'), removed.stdout + removed.stderr);

    const after = await run(['--list'], env);
    check('删除后只剩一个密钥', after.stdout.includes('1 个密钥'), after.stdout);

    const cancelled = await run(['--remove', '主账号'], env);
    check('缺少 --yes 且无交互输入时不删除', cancelled.stdout.includes('已取消'), cancelled.stdout);

    const still = await run(['--list'], env);
    check('取消后密钥依然存在', still.stdout.includes('1 个密钥'), still.stdout);

    const byIndex = await run(['--remove', '1', '--yes'], env);
    check('按序号删除密钥', byIndex.code === 0 && byIndex.stdout.includes('已删除'), byIndex.stdout + byIndex.stderr);

    const empty = await run(['--list'], env);
    check('清空后提示还没有密钥', empty.stdout.includes('还没有保存任何密钥'), empty.stdout);

    await run(['--add', '主账号', '--key', GOOD_KEY], env);
    const restored = await run(['--list'], env);
    check('恢复现场：剩一个密钥', restored.stdout.includes('1 个密钥'), restored.stdout);
  }

  {
    const r = await run(['--list', '--json'], env);
    const list = JSON.parse(r.stdout);
    addedId = list[0]?.id ?? null;
    check('列表 JSON 含 id 与掩码', Boolean(addedId) && !JSON.stringify(list).includes(GOOD_KEY));
  }

  {
    const mode = await stat(path.join(home, 'keys.json')).catch(() => null);
    check('密钥文件权限为 600', mode ? (mode.mode & 0o777) === 0o600 : false, mode ? (mode.mode & 0o777).toString(8) : '文件不存在');
  }

  {
    const r = await run(['--remove', '不存在', '--yes'], env);
    check('删除不存在的密钥报错', r.code === 1 && r.stderr.includes('找不到'), r.stderr);
  }

  section('CLI · 错误处理');
  {
    const r = await run(['--key', `sk-${'9'.repeat(28)}`, '--base-url', BASE], env);
    check('无效密钥退出码为 1', r.code === 1);
    check('给出可执行的修复建议', r.stdout.includes('platform.deepseek.com'), r.stdout);
  }
  {
    const r = await run(['--key', GOOD_KEY, '--base-url', 'http://127.0.0.1:1'], env);
    check('连接失败时友好报错', r.code === 1 && r.stdout.includes('无法连接'), r.stdout);
  }
  {
    const r = await run(['--timeout', 'abc'], env);
    check('非法参数退出码为 2', r.code === 2, `实际 ${r.code}`);
  }

  section('Web 服务');
  const port = await freePort();
  web = await startWebServer(port, env);
  const origin = `http://127.0.0.1:${port}`;

  {
    const r = await callJson(`${origin}/`);
    check('首页返回 HTML', r.status === 200 && r.text.includes('DeepSeek 余额'));
    check('首页含无障碍跳转链接', r.text.includes('跳到主内容'));
  }

  {
    const r = await callJson(`${origin}/api/state`);
    check('/api/state 返回 200', r.status === 200, String(r.status));
    check('/api/state 只返回掩码', !r.text.includes(GOOD_KEY), r.text.slice(0, 200));
    check('/api/state 含 baseUrl', typeof r.body?.baseUrl === 'string');
  }

  {
    const r = await callJson(`${origin}/api/query-all`, { method: 'POST', body: '{}' });
    check('/api/query-all 返回结果', r.status === 200 && r.body?.results?.length === 1);
    check('查询结果包含余额', r.body?.results?.[0]?.balances?.[0]?.total === 110, JSON.stringify(r.body?.results?.[0]));
    // 网页界面直接消费这些字段，契约一旦变化 UI 就会空白
    const item = r.body?.results?.[0] ?? {};
    const contract = ['ok', 'isAvailable', 'balances', 'latencyMs', 'error', 'name', 'masked'].filter(
      (field) => !(field in item)
    );
    check('响应字段满足网页界面契约', contract.length === 0, `缺少字段：${contract.join(', ')}`);
    check('余额字段为扁平结构', item.balances?.[0]?.currency === 'CNY' && item.balances?.[0]?.granted === 10);
  }

  {
    const r = await callJson(`${origin}/api/query-raw`, {
      method: 'POST',
      body: JSON.stringify({ key: GOOD_KEY }),
    });
    check('/api/query-raw 临时查询成功', r.body?.ok === true && r.body?.balances?.[0]?.total === 110);
    check('/api/query-raw 不落盘', !r.text.includes(GOOD_KEY));
  }

  {
    const r = await callJson(`${origin}/api/query-raw`, { method: 'POST', body: JSON.stringify({ key: '' }) });
    check('空密钥返回 400', r.status === 400, String(r.status));
  }

  {
    const r = await callJson(`${origin}/api/keys`, {
      method: 'POST',
      body: JSON.stringify({ name: '网页新增', key: EMPTY_KEY }),
    });
    check('新增密钥返回 201', r.status === 201, String(r.status));
    check('响应只含掩码', !r.text.includes(EMPTY_KEY));

    const dup = await callJson(`${origin}/api/keys`, { method: 'POST', body: JSON.stringify({ key: EMPTY_KEY }) });
    check('重复密钥返回 409', dup.status === 409, String(dup.status));

    const list = await callJson(`${origin}/api/state`);
    const created = list.body.keys.find((k) => k.name === '网页新增');
    check('新密钥出现在列表中', Boolean(created));

    const del = await callJson(`${origin}/api/keys/${created.id}`, { method: 'DELETE' });
    check('删除返回 200', del.status === 200, String(del.status));

    const after = await callJson(`${origin}/api/state`);
    check('删除后列表减少', after.body.keys.length === 1, JSON.stringify(after.body.keys.length));

    const missing = await callJson(`${origin}/api/keys/does-not-exist`, { method: 'DELETE' });
    check('删除不存在的密钥返回 404', missing.status === 404, String(missing.status));
  }

  section('查询记录 · 写入与去重');
  {
    const historyFile = path.join(home, 'history.jsonl');
    const readLines = async () => {
      const text = await readFile(historyFile, 'utf8').catch(() => '');
      return text.split('\n').filter((line) => line.trim()).length;
    };

    // 前面的测试已经查过好几次，记录应该已经存在
    const before = await readLines();
    check('查询后自动写入记录', before >= 1, `实际 ${before} 条`);

    const first = JSON.parse((await readFile(historyFile, 'utf8')).trim().split('\n')[0]);
    check('记录含时间/币种/余额', Boolean(first.ts) && first.currency === 'CNY' && typeof first.total === 'number',
      JSON.stringify(first));
    check('记录里没有密钥本身', !JSON.stringify(first).includes(GOOD_KEY));
    check('记录文件权限为 600',
      ((await stat(historyFile)).mode & 0o777) === 0o600,
      ((await stat(historyFile)).mode & 0o777).toString(8));

    // 余额没变且间隔很短 → 去重
    const again = await run(['--base-url', BASE], env);
    check('单次查询成功', again.code === 0, again.stderr);
    check('余额未变时 60 秒内不重复记录', (await readLines()) === before, `${before} → ${await readLines()}`);

    await run(['--base-url', BASE, '--no-record'], env);
    check('--no-record 不写记录', (await readLines()) === before);

    const noRecord = await callJson(`${origin}/api/query-all`, {
      method: 'POST', body: JSON.stringify({ record: false }),
    });
    check('接口 record:false 不写记录',
      noRecord.status === 200 && (await readLines()) === before, `${before} → ${await readLines()}`);

    const withRecord = await callJson(`${origin}/api/query-all`, { method: 'POST', body: '{}' });
    check('接口默认 record:true', withRecord.status === 200);
  }

  section('查询记录 · 构造数据后的统计与接口');
  await seedHistory(histHome, fixture.rows, HIST_KEY_ID, GOOD_KEY);
  const histPort = await freePort();
  histWeb = await startWebServer(histPort, histEnv);
  const histOrigin = `http://127.0.0.1:${histPort}`;
  {
    const r = await callJson(`${histOrigin}/api/history`);
    check('/api/history 返回 200', r.status === 200, String(r.status));
    check('读数条数正确', r.body?.summary?.readings === fixture.rows.length, String(r.body?.summary?.readings));
    check('当前余额取最后一条读数', Math.abs((r.body?.current?.CNY ?? 0) - fixture.current) < 0.001,
      JSON.stringify(r.body?.current));
    check('累计消耗推算正确', Math.abs((r.body?.summary?.spend?.CNY ?? 0) - fixture.spend) < 0.001,
      JSON.stringify(r.body?.summary?.spend));
    check('累计充值推算正确', Math.abs((r.body?.summary?.topup?.CNY ?? 0) - fixture.topup) < 0.001,
      JSON.stringify(r.body?.summary?.topup));
    check('曲线点数与读数一致', r.body?.series?.[0]?.points?.length === fixture.rows.length);
    check('日序列覆盖记录期', (r.body?.calendar?.length ?? 0) >= fixture.days - 1,
      String(r.body?.calendar?.length));
    check('事件含消耗与充值两类',
      r.body?.events?.some((e) => e.type === 'spend') && r.body?.events?.some((e) => e.type === 'topup'));
    check('接口带上密钥名称', r.body?.keys?.[0]?.name === '主账号');
    check('接口不返回完整密钥', !r.text.includes(GOOD_KEY));
    check('接口不返回原始读数文件路径', !r.text.includes('history.jsonl'));

    const limited = await callJson(`${histOrigin}/api/history?days=3`);
    check('days 参数生效', limited.body?.calendar?.length <= 3, String(limited.body?.calendar?.length));

    // 按天 + 按小时两套桶
    check('返回按天与按小时两套桶',
      Array.isArray(r.body?.buckets?.day) && Array.isArray(r.body?.buckets?.hour));
    check('按小时的桶最多 72 个', r.body.buckets.hour.length <= 72, String(r.body.buckets.hour.length));
    check('按天的桶最多 30 个', r.body.buckets.day.length <= 30, String(r.body.buckets.day.length));

    const hourBuckets = r.body.buckets.hour;
    check('小时桶相邻差 1 小时', hourBuckets.every((bucket, i) => i === 0 ||
      new Date(bucket.start) - new Date(hourBuckets[i - 1].start) === 3600000));
    check('桶的 start/end 相差一个桶宽', hourBuckets.every((bucket) =>
      new Date(bucket.end) - new Date(bucket.start) === 3600000));
    // 本地对齐：小时桶必须落在整点，日桶必须落在本地零点
    check('小时桶按本地整点对齐', hourBuckets.every((bucket) => new Date(bucket.start).getMinutes() === 0));
    check('日桶按本地零点对齐', r.body.buckets.day.every((bucket) => {
      const d = new Date(bucket.start);
      return d.getHours() === 0 && d.getMinutes() === 0;
    }), JSON.stringify(r.body.buckets.day.slice(0, 2).map((b) => b.start)));

    check('返回两种粒度的可视窗口',
      Boolean(r.body?.windows?.day?.from) && Boolean(r.body?.windows?.hour?.from));
    check('小时窗口比天窗口短', new Date(r.body.windows.hour.from) > new Date(r.body.windows.day.from));
    check('窗口内没有数据之前的空白桶', hourBuckets.length === 0 ||
      new Date(hourBuckets[0].start) >= new Date(new Date(fixture.rows[0].ts).setHours(0, 0, 0, 0)));
  }

  {
    const r = await run(['--history'], histEnv);
    check('--history 退出码为 0', r.code === 0, r.stderr);
    check('--history 显示记录条数', r.stdout.includes(`${fixture.rows.length} 条`), r.stdout.slice(0, 300));
    check('--history 显示消耗与充值', r.stdout.includes('期间消耗') && r.stdout.includes('期间充值'), r.stdout);
    const json = await run(['--history', '--json'], histEnv);
    check('--history --json 可解析', (() => {
      try { return JSON.parse(json.stdout).summary.readings === fixture.rows.length; } catch { return false; }
    })());
  }

  {
    const refused = await callJson(`${histOrigin}/api/history`, { method: 'DELETE', body: '{}' });
    check('清空记录需要显式确认', refused.status === 400, String(refused.status));

    const ok = await callJson(`${histOrigin}/api/history`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
    check('确认后清空成功', ok.status === 200, String(ok.status));
    check('清空后读数归零', (await callJson(`${histOrigin}/api/history`)).body?.summary?.readings === 0);

    const gone = await run(['--history'], histEnv);
    check('清空后 CLI 给出引导', gone.stdout.includes('还没有查询记录'), gone.stdout);

    await seedHistory(histHome, fixture.rows, HIST_KEY_ID, GOOD_KEY);
  }

  section('网页界面 · 查询记录图表');
  await checkHistoryUiRendering(histOrigin, fixture);

  section('网页界面 · 渲染');
  await checkUiRendering(origin);

  section('网页界面 · CSS 类名冲突');
  {
    // 曾经的事故：<header class="bar"> 撞上余额卡片占比条的 .bar{height:7px;overflow:hidden}，
    // 顶栏被压成 7px 高、内容被裁掉。这里防止同类问题再次出现。
    const html = await readFile(path.join(ROOT, 'ui.html'), 'utf8');
    const report = auditCssClasses(html);
    check('CSS 可解析', report.selectorCount > 30 && report.classCount > 20,
      `选择器 ${report.selectorCount} 个 / 类名 ${report.classCount} 个`);
    check('没有裸类名泄漏到其他元素或子树', report.problems.length === 0,
      report.problems.map((p) => `${p.sel} → ${p.why}`).join('\n      '));

    // 用修复前的写法自检这个审查确实有效，避免它变成永远返回 0 的空检查
    const buggy = html
      .replace('header.topbar {', 'header.bar {')
      .replace('.meter { display: flex;', '.bar { display: flex;');
    check('审查能抓到已修复的类名冲突', auditCssClasses(buggy).problems.length > 0);
  }

  section('仓库安全 · 密钥绝不能进仓库');
  {
    // 设计前提：上传的只有工具，密钥和记录永远留在本机。
    // 这里验证这个前提是被机器保证的，而不是靠人记得小心。
    const runScanner = (args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'tests/check-secrets.mjs'), ...args], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('close', (code) => resolve({ code, out }));
    });

    const tree = await runScanner([]);
    check('仓库跟踪的文件里没有密钥', tree.code === 0, tree.out);
    const history = await runScanner(['--history']);
    check('全部提交历史里没有密钥', history.code === 0, history.out);
    // git add 会立刻把内容写进对象库，哪怕 commit 被钩子拦下，
    // 所以游离对象也必须单独扫一遍
    const objects = await runScanner(['--objects']);
    check('对象库里（含游离对象）没有密钥', objects.code === 0, objects.out);

    const tracked = (await run(['--list'])).code === 0
      ? execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8' })
      : '';
    check('版本库里没有任何 data/ 文件',
      !tracked.split('\n').some((file) => /(^|\/)data\//.test(file)),
      tracked.split('\n').filter((f) => /(^|\/)data\//.test(f)).join(', '));
    check('版本库里没有密钥或记录文件',
      !tracked.split('\n').some((file) => /(keys\.json|history\.jsonl|\.env)/.test(file)));

    // 忽略规则
    const ignored = execFileSync('git', ['check-ignore', 'data/keys.json', 'keys.json', '.env'], {
      cwd: ROOT, encoding: 'utf8',
    });
    check('.gitignore 覆盖了常见密钥文件名', ignored.split('\n').filter(Boolean).length === 3, ignored);

    // pre-commit 钩子
    const hookPath = path.join(ROOT, '.githooks/pre-commit');
    check('pre-commit 钩子存在', existsSync(hookPath));
    check('pre-commit 钩子可执行', ((await stat(hookPath)).mode & 0o111) !== 0);
    const hooksPath = execFileSync('git', ['config', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8' }).trim();
    check('钩子已启用（core.hooksPath）', hooksPath === '.githooks', hooksPath);
  }

  section('Web 服务 · 安全防护');
  {
    const r = await callJson(`${origin}/api/state`, { headers: { Origin: 'https://evil.example.com' } });
    check('跨站 Origin 被拒绝', r.status === 403, String(r.status));

    const spoofed = await rawGet(port, '/api/state', { Host: 'evil.example.com' });
    check('伪造 Host 被拒绝（防 DNS rebinding）', spoofed.status === 403, String(spoofed.status));
  }
  {
    const r = await callJson(`${origin}/api/nope`);
    check('未知接口返回 404', r.status === 404, String(r.status));
  }
  {
    const r = await callJson(`${origin}/api/state`, { headers: { Origin: origin } });
    check('同源请求正常放行', r.status === 200, String(r.status));
  }
} finally {
  if (web) web.kill('SIGTERM');
  if (histWeb) histWeb.kill('SIGTERM');
  mock.server.close();
  await rm(home, { recursive: true, force: true });
  await rm(histHome, { recursive: true, force: true });
}

console.log(`\n\u001b[1m结果\u001b[0m  ${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((name) => console.log(`  \u001b[31m✗\u001b[0m ${name}`));
  process.exit(1);
}
console.log('全部通过。\n');
