# 交付说明 · 数间 Shikaku（并线收口这一轮）

本轮做的事只有一件：**把这个仓从「整局不可玩」修回可玩，并把并线留下的两套实现收成一套**。
并线拓扑：merge base = `b474374`，本地侧 `716a2bf`，远端侧 `c93b353`（并线提交 `6c17812` + `39fc352`）。
浏览器闸的基线读数：merge base 时 261 项断言全绿。

## 一、并线留下的断裂（逐条修掉）

| # | 断裂 | 症状 | 怎么修的 |
|---|---|---|---|
| 1 | `js/main.js` 里远端侧的 `restart()` 整段被裁掉，而调用点（`#btn-restart` 处理器、`window.shikaku.restart`）留着 | ES module 求值那一刻 `ReferenceError` ⇒ **整页只剩壳** | 按远端侧原文恢复该函数（重开本题：标记/撤销栈/步数/提示次数/计时/结算遮罩全归零，题面不变） |
| 2 | 并线接进来一整块追加实现（105 行）：第二份全屏 IIFE 绑**并不存在**的 `#btn-fullscreen`、第二份 `P` 键监听、第二份静音块绑 `N` | 同一颗按钮两个处理器、同一键两个 keydown ⇒ **双开关**（P 按一次净效果为零）；`#btn-fullscreen` 点了什么也不会发生，量具却算它"已实现" | 删掉那一块；全屏/暂停/静音只留仓里本来就有的那一份 |
| 3 | service worker 注册有两份：`js/main.js` 里一份、`js/sw-register.js` 里一份 | 同一个 scope 注册两次，靠浏览器自己去重——那是撞运气，不是设计 | 留 `js/sw-register.js` 那份（普通脚本：`main.js` 万一没跑起来也照样把离线壳挂上），删掉 `main.js` 那份 |
| 4 | 被删掉的那份全屏实现带前缀支持（`webkitRequestFullscreen` / `ms*` / `webkitFullscreenElement`） | 只读标准 API 的话，在老 iOS Safari 上「退出全屏」会变成「再进一次」 | **能力取并集**：前缀能力并进留下那一份（`fsElement` / `fsRequest` / `fsExit`），不是再留一份实现 |
| 5 | `js/audio/synth.js` 丢了 `let held = false;` 这一行声明，全部使用点却都在 | 每次发声都 `ReferenceError` ⇒ 音效全哑 | 恢复该行 |
| 6 | `index.html` 被并线接进一行 HUD：重复 id 的 `#btn-pause` + 没人接线的 `#btn-fullscreen` | 重复 id ⇒ 读数拿到的是哪一颗不确定；那颗全屏按钮点了没反应 | 删掉那一行；`#btn-sound` 的 title 由「· N」改为「· M」（静音键是 M，N 是再来一局） |
| 7 | `css/game.css` 注释里指着 `BTN#btn-fullscreen` | 文档印着一个不存在的按钮 | 改成真实存在的 `BTN#btn-full` |
| 8 | 键 `R` 原来绑 `restartRun()`（重开本局），而页面三处文案都写着 R = 重开本题 | 键与按钮说的不是一件事 | 键改走 `restart()`；**「重开本局」保留**为暂停遮罩里的另一颗按钮（不绑键） |

## 二、闸：一条断言都没删，强度只升不降

- `tools/scenarios.js`（play 腿）**补了一步真实落子**：`#btn-new` 换局之后先 `A().drawBox(...)` 落一子。
  为什么是「补 setup」而不是「改断言」：那条「暂停前这一局有花费」要求 `moves > 0`，而同一条腿前一步刚断言过
  「换一局清零步数 = 0」，且此前只用过提示与撤销（提示不计步）⇒ **闸自己跟自己打架**，任何产品行为都满足不了。
  归因已核实：并线**前**就是红的（侧A `716a2bf` 同样 85 checks / 1 failed，同一条；merge base `b474374` 全绿，play 腿 59 checks）。
  补了这一步之后，暂停遮罩写出的花费、恢复不丢步数/提示/已围格这几条下游断言才真正咬住状态。
- 新增 4 条断言（都只加不减）：`落子后步数进一`、`落子后围下一块`、`继续带回刚才那一步`、`全屏按钮写了按下态`。
- `tools/deploy-set.mjs`：**实数钉** `EXPECT_CHECKS 46 → 45`、`EXPECT_ROWS 65 → 64`
  （少一条被扫到的引用——`main.js` 里那份 `new URL('sw.js', document.baseURI)` 没了；
  `sw.js` 本身仍被 `js/sw-register.js` 的 `serviceWorker.register('sw.js', …)` 指着，产物里缺它照样红）。
  **钉的是实数，强度不变**：R12/R13 两条断言本身没动。
- `tools/deploy-set-selftest.mjs` 未改：十三刀全部照旧发力（X10 阴性对照照样按预期不发力）。

## 三、文档按实测读数对齐

`README.md` / `DESIGN.md` / `.github/workflows/ci.yml`：
159 项 Node 断言、**291** 项浏览器断言（play 腿 89）、部署集 45 条引用 / 64 行断言；
键位表补齐（K 换模式、P 暂停、R 重开本题、N 再来一局、M 静音、F 全屏、? 教学；
原先 README 把「画线模式」写成 `M`，与代码相反）；`DESIGN.md` 新增 §12「三个『再来一次』：题面不变，深度不同」。

## 四、实数读数（本机实跑）

```
npm run check          OK
npm test               159 通过 / 0 失败
npm run balance        阶梯成立（30/30 局穷举复核与铅笔判定一致）
npm run parity         帧率无关成立，尺子自证有效
bash tools/verify.sh   9 腿 291 checks / 0 failed（root 形态）
                       9 腿 291 checks / 0 failed（前缀形态 = Pages 实际服务的形态）
deploy-set             45 条引用（含 3 张位图尺寸核对），失败 0 项 / rows 64
deploy-set-selftest    rc=0（每一刀都按预期发力）
```

## 五、需人接手的三条

1. **R 键语义**：本轮按页面自身三处文案定为「重开本题」。若要改成「重开本局」，得同时改
   `js/main.js` 的键表、`index.html` 的 `#btn-restart` title、README/DESIGN 的键位文案 —— 四处一起改，别只改一处。
2. **那条「暂停前这一局有花费」**：并线前就红，根因是闸自身矛盾。本轮用「补一步真实落子」让它变真。
   若判断「换一局之后本来就该有花费」这条断言该改写、而不是补 setup，那要拍板后连断言与场景一起重写。
3. **`js/sw-register.js` 的去留**：本轮把它留作唯一的 SW 注册点。若组织规范要求注册必须住在模块里，
   改回 `main.js` 一份即可，但要同步把 `EXPECT_CHECKS` 改回 46、`EXPECT_ROWS` 改回 65。

## 六、改过的文件

```
js/main.js            恢复 restart()；R 改走 restart()；删并线接进的追加块与重复 SW 注册；
                      全屏前缀能力并进留下那一份
js/audio/synth.js     恢复 let held = false;
index.html            删重复 HUD 行；#btn-sound title 改 · M；键位文案 R 重开本题
css/game.css          注释里的按钮 id 改成真实存在的 #btn-full
tools/scenarios.js    play 腿补一步真实落子 + 4 条新断言
tools/deploy-set.mjs  实数钉 45 / 64
README.md / DESIGN.md / .github/workflows/ci.yml   读数与键位对齐
deliverable.md        本文件（新建）
```
