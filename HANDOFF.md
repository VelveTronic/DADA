# HANDOFF — Plan 13 客户端手机版重设计（暂停点：Task 2 完成后）

> 写于 2026-08-18 深夜。本文件是会话交接：Plan 13 九个任务完成了 1-2，按 owner 指示在此暂停并推送 GitHub。下次会话从「下一步」一节接续。过期后删除本文件。

## ⚠️ 先读这个：本次推送会触发生产部署

`main` 连着 Vercel（dada-pedidos.com，生产站，真实客户在用）。**推送 main = 自动发布当前半成品状态**。Vercel 没配 Ignored Build Step，commit 信息里的 `[skip ci]` 不起作用。当前状态发到生产的后果：

- **目录页搜索框指向 `/buscar`，该路由要到 Task 3 才存在 → 点击 404**（最主要的破损点）
- 目录页已是新版双栏（左分类栏 + 右商品列表），其余页面还是旧版白玻璃风格 → 风格过渡期混搭
- 手机底部还是旧的红色购物条（Task 5 才换成设计稿的黑色需求单条 + 底部四标签导航）

**若不想让客户看到这个状态**：Vercel Dashboard → Deployments → 上一个部署 → Instant Rollback（一键回滚，不影响 git）；或者下次会话第一件事做 Task 3（把 /buscar 建出来，404 即消失）。

## 背景：这是在做什么

把门户**客户侧**按 owner 在 Claude Design 里定稿的手机版设计（需求单模式）整体重构。设计稿已入库：`docs/design/dada-mobile-client.dc.html`（7 屏 390×844，内联样式即规格；`support.js` 只是画布运行时，忽略）。

- **计划（唯一权威）**：`docs/superpowers/plans/2026-08-18-13-client-mobile-redesign.md` — 9 个任务、锁定的设计决策（哪些 mockup 元素故意不做、哪些门户功能设计稿没画但必须保留）、精确到类名的令牌表。动手前通读。
- **流程**：writing-plans + subagent-driven-development（Opus 实现者 + 规格合规/代码质量双评审，每任务一轮，评审提出的问题打回实现者修复后复核）。
- **员工侧 (/staff) 不动布局**，只继承新令牌。

## 进度

### ✅ Task 1 — 令牌/字体/控件词汇/状态筹码（完整走完双评审，Approved）

提交：`91b75e8` 主体 → `b6e2cc5` 修 AA+悬停 → `90b70c7` 修 muted → `f00b71a` 质量评审修复 → `c607eb1` 控制器注释修正。

要点：
- `globals.css` @theme = 暖米色令牌表（`#F1EEEB` 底 / 纯白卡 / 品牌红 `#E0231C`+文字红 `#B31710` / `--color-field`+`--color-field-border`（评审后补的令牌）/ `rounded-card` 14px / `--font-num`=Archivo 可变字体，仅拉丁子集自托管）。
- `GLASS_CARD` → `CARD`（毛玻璃全面退役，纯白实心卡）；步进器词汇 `STEPPER_WRAP/DEC/INC/QTY`（两颗分离的 32px 方钮，+ 红实心）；qty-stepper 的 keyed-DOM/焦点交接契约原样保留。
- 订单状态筹码 7 态新配色。**评审揪出并已修的三个对比度问题**：confirmed 筹码文字 `#B26A00`→`#9A5C00`（mockup 自己不达 AA）；`--color-muted` `#79726B`→`#6E6760`（米色底上 4.10→4.82）；员工页 `hover:bg-white/50` 在纯白卡上隐形→`hover:bg-surface-dim`（4 处）。
- 占位符用 `text-faint`（2.47:1）是**有意的设计忠实**，前提是每个字段都有可见 label 或 aria-label——规则写在 `--color-faint` 的注释里，别破坏。

### ✅ Task 2 — 分类点货双栏（已实现+门禁全绿；⚠️ 双评审按 owner 加速指示跳过，未补）

提交：`28c3489`。811 测试 / 25 文件，五道门禁全过。

要点：
- AppShell 新增 `layout` prop（`"page"` 与旧版逐元素一致 / `"viewport"` = `h-dvh` 双栏独立滚动，仅 /catalogo 用）。
- 左栏 88px（lg:208px）= 全部 + 常购(带收藏数) + 61 个分类，`rail-autoscroll.tsx` 保证硬加载时高亮项滚入视野；右栏 sticky 分类头 + 商品行 + 分页/空态/128px 底部垫片都在栏内。
- `product-row.tsx` 迁至 `src/components/`（Task 3 的 /buscar 要复用），网格/固定动作列/星标未动。
- 目录页删除了搜索表单、`?q`、`?focus`、收藏 tab、分类筹码条——搜索职责整体移交 /buscar（Task 3）。
- 实现者实测修了一个真 bug：西语分类名（如 Electrodomésticos）撑破 88px 栏使其横向滚动 → label 包 `<span className="min-w-0 break-words">`。
- i18n：新增 `catalog.notice/railLabel/railAll/railFavorites/paneFavorites/paneCount`；删了死键 `title/tabAll/tabFavorites/catAll`；**`searchButton` 不是死键**（staff/productos 在用，计划里的假设错了，已留下）；`searchPlaceholder` 改为设计稿文案（搜索商品 / 品牌 / 规格）。

### ⏳ Task 3-9 未开始

③ /buscar 搜索页（本地历史 localStorage）→ ④ /cuenta 我的账号（统计+菜单）→ ⑤ 壳层替换（底部四标签 TabBar + 黑色需求单悬浮条 + 头部拆分）→ ⑥ /carrito 需求单重构（清空、固定提交栏）→ ⑦ /pedidos 订单卡片+状态标签+再来一单 → ⑧ perfil/direcciones/login 打磨 + 西语通读 → ⑨ 全量验证。

## 下一步（按顺序）

1. **最优先：Task 3（/buscar）** — 消除生产 404。计划文本自足。
2. **Task 2 补课**：
   - 双评审没做（规格合规 + 代码质量各一轮）。至少让下个会话的评审者把 `c607eb1..28c3489` 过一遍。
   - **待裁决的真问题——商品名列太窄**：390px 屏上名称列仅 74px（375px 屏 ~59px），长名只剩 3-4 个字 + 省略号，B2B 场景靠名称区分商品，这不可用。实现者给了三个回收方案；**控制器倾向**：星标移出动作列、挪进 meta 行（-40px，名称列 ~114px，与设计稿等宽）+ `STEPPER_QTY` 上限收到 `max-w-6`、槽位 100px→92px（-8px）。**在 Task 3 动工前先定并实施**（/buscar 复用 ProductRow，别让两页各改一次）。
   - **真人登录过目**：子代理不能输密码（安全边界，正确行为），Task 2 的浏览器验证是「临时路由 + 生产真数据 + 几何测量」替代完成的，**没有人以 cliente-test 真登录看过新目录页**。owner 自己或控制器会话登录扫一眼（帐密在 `docs/comandos.md` §测试账号）。
3. 然后按计划 Task 4 → 5 → … → 9 继续，每任务恢复双评审节奏。

## 过渡期已知状态（都是计划内的，别当 bug 修）

| 状态 | 解除于 |
|---|---|
| 目录页搜索框 → /buscar 404 | Task 3 |
| 旧红色购物条还在（含 viewport 模式下其 h-20 垫片把双栏挤矮 ~11px 的小瑕疵） | Task 5 重写 cart-bar.tsx |
| 顶部导航搜索图标 → `?focus=search` 已失效（落回目录页） | Task 5 改指 /buscar |
| cart-bar 的 `hover:bg-brand/90` 与 BTN_PRIMARY 新规矩不一致 | Task 5 |
| /carrito、/pedidos、/perfil、/direcciones、/cuenta(不存在) 还是旧结构 | Task 4-8 |
| `catalog.empty` 键疑似死键（Task 2 之前就没人引用） | 顺手清理即可 |

## 坑与纪律（下个会话必读）

- **生产安全红线**：数据库是生产库、桥接在 OSCAR 上实跑。**验证时绝不提交订单**（提交 = 注入 ERP）；购物车 cookie 写入没关系但结束时清空；改过的员工开关（show_prices 等）必须还原。
- **门禁**（每次提交前，仓库根目录）：`pnpm bridge:build` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`，全零。当前基线 811 测试。
- 提交尾行：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。**未经 owner 明示不推送**（本次推送是 owner 2026-08-18 明示指令）。
- **删路由后要清 `.next`**，否则 typecheck 撞上过期的生成 validator.ts。
- `next build` 偶发 0xC0000005 崩溃（Windows worker flake）：重跑或删 `.next`；注意 `build | tail` 会吞退出码。
- 子代理浏览器验证：preview pane 的 `screenshot` 会超时（不合成帧）——用 read_page / javascript_tool 量计算样式和几何，或对真 Chrome 窗口截图。
- i18n 双语齐平是测试强制的（zh 缺 es 或反之直接红）。es 要写真商用西语。
- 本仓库**注释是承重墙**：改行为必须同步改注释，评审会核对注释与事实。
- Next 16 与训练数据不同：先读 `AGENTS.md` + `node_modules/next/dist/docs/`；middleware 叫 `src/proxy.ts`。

## Git / 分支

- 本次推送：`main`（a65fd4a 计划 → 91b75e8/b6e2cc5/90b70c7/f00b71a Task1 → c607eb1 → 28c3489 Task2 → 本 HANDOFF 提交）与新建的 `dev`（= main 同点）。
- `hardening-remediation`：安全审计遗留的旧分支，内容已并入 main（61d974a 一线），仅作历史保留，未动。
