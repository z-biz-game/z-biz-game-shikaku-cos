# 数间 · Shikaku（零猜测矩形分区推理）

> *数字不告诉你块在哪儿，只告诉你它有多大。每一局在出货前都被铅笔求解器推到底过一次，唯一解由第二套互不信任的代码逐格复核。*

浏览器原生的 **Shikaku / 数间**：无构建步骤、无打包器、**零美术与音频文件**——棋盘、区域色、
分域笔记、数字盘全部由 canvas 现画，音效由 WebAudio 合成，界面只有一个 `<canvas>`。

玩法是把整块盘切成若干长方形：**每块恰好围住一个数字，格数恰好等于那个数字**。

- **核心承诺 1｜零猜测**：出货的每一局都能 **只用铅笔规则从空盘围到底**。这不是文案，是准入门槛——
  `solve()` 推不到底的候选盘直接丢弃；实测 397 个唯一盘 **397 个**推得完，出货盘里 `反证` 出手 **0 次**。
- **核心承诺 2｜唯一解**：`countSolutions()` 是一台**不带候选池、不带位掩码、不带任何推理逻辑**的
  逐格穷举计数器。它和铅笔求解器从两个方向回答同一个问题，还要**逐格**给出同一份切法，否则不出货。
- **核心承诺 3｜提示不是答案**：提示走的是**同一个** `nextDeduction()`，所以它必须点名用了哪条规则、
  落在哪一格（`10 格区域 只剩一种形状：第1~5行 × 第5~6列`）；纯排除、玩家无从下手的那一步**不收费**，
  程序会继续往下找真正能落子的那一步。
- 难度不是标签：`初学 → 大师` 五档的分数带是**实测**出来的（`npm run balance` 打印分位表），
  `TIERS` 里的 `band` 是**选取目标**——每档一直抽盘，直到分数落进自己的区间，`balance` 再盯着这件事不许漂移。
- 规模：10 个 ES Module / 2,499 行 JS + 8 个验证脚本 / 2,400 行 + 514 行 CSS/HTML，**运行时依赖 0 个**。
- 验证：**128 项 Node 断言** + **261 项浏览器断言**（9 个场景，读 DOM 几何与画布像素，不读标志位）。
- **在线试玩**：<https://z-biz-game.github.io/z-biz-game-shikaku-cos/>（`main` 分支推送即自动部署）

---

## 快速开始

```bash
npm start            # 零依赖静态服务 → http://127.0.0.1:5173
npm run dev          # 本项目专用端口 5251（验证脚本用同一个）
npm run electron     # 桌面壳（electron/main.cjs，同一份代码）
```

```bash
npm run check        # 逐文件 node --check 语法门禁
npm test             # 引擎断言 128 项：规则可靠性 / 生成保证 / 状态机 / 存档形状
npm run balance      # 难度实测台：每档分数分位、命中率、求解代价、档位阶梯门禁
npm run verify       # 无头 Chrome 跑 9 个浏览器场景（需本机 Chrome，见下）
```

`npm run verify` 自己起服务、自己开 Chrome、自己收尾，退出码即结论：

```
=== engine ===  34 checks, 0 failed  {score: 91, clues: 14}
=== gen ===     33 checks, 0 failed  {medians: [46.25, 86.5, 141.5, 214, 285.5]}
=== play ===    59 checks, 0 failed
=== hint ===    14 checks, 0 failed  {hints: 100, rules: [唯一归属, 区域锁定, 全线穿透]}
=== box ===     29 checks, 0 failed
=== cut ===     22 checks, 0 failed
=== save ===    21 checks, 0 failed
=== resume ===  25 checks, 0 failed
=== layout ===  24 checks, 0 failed  {cell: 58, dpr: 1}
=== ALL GREEN ===
```

同一套断言可以直接打线上产物，"部署过没部署过"不是一句声明：

```bash
BASE_URL=https://z-biz-game.github.io/z-biz-game-shikaku-cos/ npm run verify
```

---

## 玩法

| 操作 | 行为 |
|---|---|
| **按住并拖动** | 圈出一个矩形。面积与数字相等、且只圈住这一个数字 → 落子；否则拒绝并说出为什么 |
| **点击已围的格** | 擦掉这一格的归属，候选池立刻退回还剩下的放法 |
| **画线模式**（或 `M`） | 点两格之间的线，记一条"这两格不可能同域"的**笔记**；再点一次擦掉 |
| **提示**（或 `H`） | 给出当前推得出的下一步，并点名规则；这一步真的落子，也真的计入求助次数 |
| **撤销**（或 `Z`） | 退掉一整个手势——一次拖动是一步，不是一格一步 |

判胜用的是 `verify()`：只读归属表，检查"每格都有归属、每块都是矩形、面积等于自己的数字、
块里不含别人的数字"。它不读候选池，所以**剪枝逻辑写错也伪造不出一场胜利**。

---

## 六条规则（提示只会说这些）

| 规则 | 说什么 | 权重 |
|---|---|---|
| 唯一归属 | 一格只剩一个数字放得下它 → 那格就归这个数 | 1 |
| 必然分域 | 没有任何一种放法能把两格圈在一起 → 中间画线 | 1 |
| 区域锁定 | 一个数字只剩一种形状 → 整块当场围出来 | 1.5 |
| 全线穿透 | 它所有可能的放法都盖住同一格 → 那格必在它里面 | 2 |
| 无处安放 | 这块一放，别处就没地方放了 → 所以不能这么放 | 3 |
| 反证 | 假设这里这么放，推到底会矛盾 → 假设反了 | 6 |

`反证` 是安全网而不是日常工具：出货的每一档都让它出手 **0 次**（见下表），
但它一旦出手就必须可靠——浏览器场景会把"反证排除掉的矩形"和穷举给出的正解逐一比对。

---

## 难度是量出来的

`npm run balance`（SAMPLES=40，2026-09-27）：

| 档 | 盘面 | 分数带（选取目标） | 实测中位 | 命中区间 | 平均抽几次 | 出题耗时 |
|---|---|---|---|---|---|---|
| 初学 | 6×6 | 38–58 | 48.0 | 40/40 | 1.6 | 1 ms/局 |
| 上手 | 8×8 | 70–106 | 89.5 | 40/40 | 1.5 | 0 ms/局 |
| 熟练 | 10×10 | 118–172 | 145.5 | 40/40 | 1.4 | 1 ms/局 |
| 高阶 | 12×12 | 180–258 | 211.0 | 40/40 | 2.2 | 4 ms/局 |
| 大师 | 14×14 | 240–345 | 293.5 | 40/40 | 2.0 | 4 ms/局 |

每一档的 `反证` 次数中位都是 **0**（`balance` 会打印这一列，它不许悄悄变成 1）。

分数是**推理步数的加权和**，所以它随盘面变大而变长——档位排的是"要思考多少"，
不是"格子有多少"。`balance` 会拒绝一个不再单调的阶梯，也会拒绝一个命中率掉到个位数的档。

---

## 目录

```
index.html          一个 canvas + 侧栏读数
css/game.css        全部颜色来自 theme.js 注入的 CSS 变量
js/engine/shikaku.js  模型、六条规则、铅笔求解、独立 verify/diagnose
js/engine/count.js    独立的逐格穷举计数器（唯一性的第二意见）
js/engine/generate.js 切块、合并、数字落位、按难度带抽盘
js/ui/game.js       状态机：手势、撤销、提示、判胜
js/render/board.js  几何 + 绘制 + 命中（格子与"两格之间的线"）
js/store.js         localStorage 单键存档：种子 + 归属 + 这一局的花费
tools/              engine-test / balance / playtest(CDP) / scenarios / verify.sh / tools/assemble-site / tools/deploy-set / tools/deploy-set-selftest
tools/assemble-site.sh  部署产物的唯一清单（pages.yml 与本地闸调同一支）
tools/deploy-set.mjs  部署集闸：检查即将上传的那份产物
tools/deploy-set-selftest.mjs  部署集闸的阴性自证（每一类断言当场打红一次）
```

## 许可

MIT。见 `LICENSE`。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高。
- **钉住两个数**：`EXPECT_CHECKS=27`（R 段实际检查的路径条数）与 `EXPECT_ROWS=45`
  （这一次跑的断言条数）。没改页面却掉了，说明解析断了；删掉一张图标会同时少一条 R10 与那张的
  P1/P2，所以两个数一起钉，rows 能漂就是闸在缩水的信号。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`27`、rows 仍然 `45`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑，所以页面改了、仓与仓不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；把它们接进本仓
那条浏览器 one-shot（`tools/verify.sh`）还欠着——那道脚本的腿名单与条数钉是每个仓自己的形状。
