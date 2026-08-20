# HANDOFF — Plan 14 商家端后台重设计（A1-A8 全部闭环）

> 写于 2026-08-20，接替 2026-08-19 的 Plan 13 交接（该轮客户端手机版 Task 1-9 已全部完成并合入本分支历史）。本轮会话（Claude Code Remote，Linux 容器）完成 Plan 14 全部八个任务。分支 `claude/dada-mobile-ui-optimization-jgrc84`，Plan 14 范围 `40b114a..HEAD`。计划文档 `docs/superpowers/plans/2026-08-19-14-staff-admin-redesign.md` 是唯一权威（每个任务带 Shipped 注记）。过期后删除本文件。

## 状态总览

| 任务 | 状态 | 说明 |
|---|---|---|
| A1 侧栏壳层 | ✅ | 六项导航（新增 分类）、真实待办计数（`readCount` null-诚实契约 + `src/lib/shell-counts.ts` 表测试）、`staff.nav.users` 改 客户/Clientes；drawer/图标栏契约逐字保留 |
| A2 分类管理 | ✅ | `/staff/categorias` 零新 RPC（session client + `is_staff()` RLS 逃生口）；rail 顺序与点货台 BY CONSTRUCTION 同源（`sortCategories` 单源）；计数走 `scan-windows` 窗口扫描破 `max_rows=1000` |
| A3 商品表+分类指派 | ✅ | mockup 表格 + 每行分类指派（service-role 惯用法）；`?cat=none` 找未归档商品；三开关 revalidate 升级双语言 catalogo/buscar/carrito；`assertStaff`/`formText` 收敛 |
| A4 订单队列 | ✅ | 真实 7 态状态机不动，chips 带真实计数；staff `order_items` 无界读补 `.order("order_id").order("sort_order").limit(1000)`；页脚首次诚实说出 50 条上限 |
| A5 仪表盘 | ✅ | 真 KPI（`madridDayStartIso` DST-证明：两个拨钟日表测试 + 复核 17,520 小时暴力验证）、五态漏斗、停售卡、待办卡带计数页脚；桥接心跳逐字节保留 |
| A6 客户页 | ✅ | 公司优先账号簿（按 `company_id` 分组）、三格统计（读失败画 —）、真实本月单量（月起点窗口扫描，失败即闭）；全部用户管理机制保留 |
| A7 设置 | ✅ | ADMIN_CARD + 44×26/20/18px 开关（精确 token 填色）；`sr-only` checkbox + hidden-`0` 契约逐字节保留；焦点环加 offset |
| A8 终审 | ✅ | 五项台账清理（`3690653`）+ 全范围跨任务终审 **SHIP**（安全门、one-off 台账、AA、i18n、单源不变量、客户面零越界全过） |

流程：每任务 = Opus(xhigh) 实现者 → 规格+质量并行双评审 → 裁决修复轮（fixer→verifier 串行）→ 注释级残留由控制器直接修。每个提交都过五道门禁（bridge:build / lint / typecheck / test / build）。测试 953 → **1046**（31 文件；新增 scan-windows、shell-counts、categories resolveCatFilter/catNeedsCategories、madridDayStartIso/funnelWidth、company-accounts、readLoggedCount 各表）。

## ⚠️ Owner 必办（本环境做不了的）

1. **真人登录走查（商家端六屏 zh+es，1280 桌面 + 平板栏 + 手机 drawer）**：首页仪表盘（KPI/漏斗/停售卡/待办卡/心跳）、订单队列（chips 计数与侧栏角标一致性、确认/取消/重新入队/行数量编辑——**在真单上操作前想清楚，confirm 会推进真实状态机**）、商品表（分类指派下拉 + 保存、`?cat=none` 未归档视图、筛选 chips）、分类管理（**上移/下移实测对照点货台 rail**——首次移动会把 freepos 撞号的 sort_order 重排为 10/20/30…）、客户页（本月单量与统计条、停用/启用）、设置（开关拨动 + 保存 + 键盘 Tab 焦点环——A8 有一个人眼未验的 C3 夹具 `scratchpad` 已随会话回收，直接真机看即可）。
2. **角色矩阵**：分别以 owner / manager / staff 登录：staff 应看不到 客户/设置 入口且直敲 URL 被弹回；manager 看得到 客户 但看不到员工账号半区；分类/商品操作三种角色都可用（决策 12 的既定口径）。
3. **CCR 环境白名单加 `*.supabase.co`**：本容器出网被代理 403，全部浏览器验证只能用夹具替代；加了白名单，下个会话就能真登录验证（Plan 13 起的老项，仍未做）。
4. **Plan 13 遗留的客户侧走查项仍然站着**（上一份 HANDOFF 的 1/2/3/5 条）：七屏客户端走查、show_prices 开关矩阵、真机安全区、两个产品裁量（es 底栏 tabCart 单复数、favAdd aria 用词）。

## 已接受的既知状态（不是 bug——多数在代码注释里有完整论证）

- **三读者重复计数**：侧栏、队列 chips、仪表盘各自读 submitted/bridge_failed/停售（同请求内最多 3 次重复往返，毫秒差可致侧栏角标与 chip 短暂不一致——都真实，无谎报）。`cache()` 统一是记录在案、刻意未做的设计变更（`pedidos/page.tsx` 与 `staff/page.tsx` 计数块注释各有交叉引用）。
- **`/cuenta` 四个 head 计数日志盲 + `?? 0`**：客户「我的」页失败读会渲染 0 而非破折号，且日志无 status（`cuenta/page.tsx:172-185`）。诚实修法 = `readLoggedCount` + 破折号（照侧栏）。客户侧文件，Plan 14 刻意未触。
- **订单队列无真分页**：50 条上限现已在页脚诚实标注；真分页是 owner 优先级跟进项。
- **分类写权限 = 任意在职 staff**（决策 12）：收紧到 manager+ 需要新 RPC + 安全基线扩容，刻意未做。
- **品牌链接双名**：侧栏「DADA」与手机顶栏「员工后台」同指 /staff，两者都真实。
- **`lib/profile.ts` 还有一份与 `formText` 同体的 `text`**（客户侧、先于该模块存在；`form-text.ts` 文档已具名，下次触碰 profile 时折并）。
- **`readCount` 生产侧唯一调用者是 `readLoggedCount`**：决策 8 要求纯决策单独可测，勿被死导出清扫误删（`shell-counts.test.ts` 直接钉它）。
- 停售商品 是 staff 侧词（客户侧词是 断货/Agotado）——同一列两套受众词汇，决策 2 修订后固定。
- 设置开关 ON 态焦点环靠 2px 白 offset 与品牌轨道分离（`#fff` 默认之所以成立：开关在 ADMIN_CARD 白底上，不在米色 wash 上——`settings-form.tsx` 注释有全套论证与逃生口写法）。
- 安全基线一字未动：整个 Plan-14 范围 `supabase/`、`package.json`、`pnpm-lock.yaml`、`src/lib/auth/guards.ts` **零 diff**；12 个 `.rpc()` 调用名恰为 CLAUDE.md 基线；每个新写入点各归其 lane（categories=session+RLS、products=service-role、其余未动）。

## 纪律与坑（沿用 Plan 13 + 本轮新增）

- **生产红线**不变：绝不提交订单、绝不提交任何 staff 表单（confirm/cancel/requeue/设置保存都打真库真 RPC）；夹具路由提交前必删并清 `.next`。
- 门禁五道全零才提交；提交尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` 行。
- **注释承重**已是硬文化：本轮八个修复轮里，修复者两次纠正了控制器修复单里的错误前提（order_number 并非日期序号、心跳年龄可超一天），复核者逐行开文件核对每个引用行号。改行为必同步改注释；**数字必须自算**；mockup 行号引用要开文件确认。
- **诚实渲染铁律**：失败读画 `—` 绝不画 0（`readCount`/`readLoggedCount`）；计数与列表分读（列表挂了计数还活着）；截断必有可见信号（队列/待办页脚、扫描封顶日志）。
- **Tailwind v4 扫原文**：注释里写全 utility 名会编译出死规则——写破（`settings-form.tsx` M2 有先例与写法）。
- PostgREST `max_rows=1000`（`supabase/config.toml:18`）：>1000 行读取一律 `scan-windows` 窗口化或显式 limit + 诚实注释；商品表实测 **2,971 行**。
- Next 16：读 `AGENTS.md`；`searchParams` 是 Promise；middleware 在 `src/proxy.ts`。
- 五种写机制不可混用（CLAUDE.md）；`assertStaff` 唯一定义在 `src/lib/auth/assert-staff.ts`（throw 型，永不 redirect）。

## Git

- 本分支：`claude/dada-mobile-ui-optimization-jgrc84`（远端同步，含 Plan 13 + Plan 14 全部）。`main` 仍在 `6c94d0b` —— **合并本分支即同时上线客户端手机版与商家端后台**；合并前 Vercel 生产不受影响。
- `dev` 分支仍在 6c94d0b 同点，未动。
