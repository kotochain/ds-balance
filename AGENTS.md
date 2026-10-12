# 给 AI 代理 / 协作者的约定

本文件记录这个项目的硬性约定和踩过的坑。改动代码前请先读一遍。

## 项目是什么

零依赖的 DeepSeek API Key 余额查询工具：命令行 + 本地网页版。
只用 Node.js 内置能力（`fetch` / `http` / `vm` / `Intl`），**不引入任何 npm 依赖**，
不要为了图方便加库 —— 「零依赖」是这个项目的核心卖点之一。

## 第一条：密钥安全

**只上传工具，密钥和查询记录永远留在用户本机。** 这条由三道锁保证，改代码时不要削弱任何一道：

| 锁 | 位置 |
| --- | --- |
| 忽略规则 | `.gitignore` |
| 提交拦截 | `.githooks/pre-commit` → `tests/check-secrets.mjs --staged` |
| 自查 + CI | `npm run check-secrets`、`.github/workflows/test.yml` 的 `secrets` job |

### 严禁事项

1. **不要拿真实的 `data/keys.json` 做任何测试。** 要验证拦截逻辑，在临时目录造假密钥。
2. **不要对 `data/` 执行 `git add -f`**，哪怕只是「试一下」。
   `git add` 会立刻把内容写进 `.git/objects`，即使提交随后被拒绝、或马上 `git reset`。
   **「提交被拦下」≠「内容没进 .git」。**
3. 不要把完整密钥写进日志、报错信息、网页响应或测试快照。一律走 `maskKey()`（`sk-••••••c3d4`）。
4. 新增任何输出（CLI / HTTP / 前端）时，确认它只出现掩码。

### 如果怀疑有泄露

```bash
node tests/check-secrets.mjs --objects    # 扫整个对象库，含游离对象
git reflog expire --expire=now --all && git gc --prune=now   # 清理游离副本
```

排查结论要给**可复核的证据**（远程配置、全对象命中数、`git fsck`），不要只说「没问题」。
另外务必先分清「本地对象库有副本」和「已经推到远端」—— 两者风险差一个数量级。

## 第二条：改完必须跑测试

```bash
node tests/self-test.mjs      # 149 项，全走本地 mock，不消耗真实额度
```

测试结构：

- `tests/self-test.mjs` —— 主测试。用真实 `ui.html` 脚本 + 极简 DOM 桩在 Node 里跑界面渲染，
  所以**前端改动也能被断言覆盖**，不是只测后端。
- `tests/check-secrets.mjs` —— 密钥检查，四种模式：tree / staged / history / objects。
- `tests/css-audit.mjs` —— CSS 类名冲突审查，见下。

新增功能请补对应断言。**测试要能真的失败**：给审查类检查加一条「注入已知错误应被抓到」的自检，
避免它退化成一个永远通过的摆设。

## 第三条：图表约定

- 桶的时间边界必须按**本地时区**对齐。直接用 `Math.floor(now / 86400000)` 得到的是 UTC 零点，
  在东八区就是本地 08:00，`start`/`end` 会把区间显示错。
- 悬停交互用**事件委托**：所有 `querySelector` 都写在事件回调里。
  渲染函数自己不能碰 DOM 查询 API，否则测试环境（只有 `innerHTML` 的 DOM 桩）会直接抛错。
- 折线图的悬停坐标要把 SVG 用户单位换算成 CSS 像素：
  先取 `svg.getBoundingClientRect()`，再按 `rect.width / viewBox.width` 缩放。
- 截图验证时注意 `Page.captureScreenshot` 的 `captureBeyondViewport: true` 会重排页面并
  **丢掉悬停等瞬时状态**；要截悬停效果必须只截视口。
  另外 `clip` 用的是**页面坐标**，不是视口坐标。

## 第四条：CSS 类名不要重名

`tests/css-audit.mjs` 会拦截「裸类名泄漏」：同一个类既写了 `.foo { ... }`，
又用在别的元素上（`header.foo`）或别人的子树里（`.other .foo`）。

**这是踩过的真实事故**：顶栏曾经写成 `<header class="bar">`，
而余额卡片占比条用了 `.bar { height: 7px; overflow: hidden }` ——
级联把顶栏压成 7px 高，logo 和标题全被裁掉。

写新样式时：一个类名只用一种选择器形式，不要既裸写又加限定。

## 第五条：数据格式

`data/history.jsonl` 是追加写入的 JSONL，一行一条读数：

```json
{"ts":"2026-01-01T10:00:00.000Z","keyId":"<密钥 id>","currency":"CNY","total":100.00,"granted":10.00,"toppedUp":90.00}
```

- 追加写入，**不要整体重写**（写一半断电也不能损坏已有数据）
- 解析时坏行直接跳过，不要让一条坏数据毁掉整个历史
- 消耗/充值是**相邻两条读数做差**推算的：余额下降 = 消耗，上升 = 充值。
  官方没有用量接口，这是唯一可行的方法 —— 不要在文档里把它说成「精确账单」
- 写文档示例时用上面这种假数值，**不要贴真实余额和时间戳**

## 第六条：网页版的边界

- 只监听 `127.0.0.1`
- 校验 `Host`（防 DNS 重绑定）和 `Origin`（防跨站调用）
- 不发任何 `Access-Control-Allow-Origin`
- 记录分两种：网页定时刷新走 `auto: true`，由服务端按 `SAMPLE_MINUTES`（默认 5 分钟）限流；
  手动刷新和命令行查询不限流，点一次记一次。限流只影响「要不要写记录」，不影响余额本身的刷新。
  否则网页挂一天就是上万条噪声。

## 发布前检查清单

```bash
node tests/self-test.mjs          # 全绿
npm run check-secrets             # 四种模式全过
node --check ds-balance.mjs       # 语法
git status                        # 确认 data/ 不在暂存区
git log --stat -1                 # 确认提交内容里没有密钥文件
```
