# HANDOFF — Plan 13 客户端手机版重设计（完成：Task 1-9 全部闭环）

> 写于 2026-08-19，接替 2026-08-18 深夜的暂停点交接。本轮会话（Claude Code Remote，Linux 容器）从 Task 2 补课起步，完成了 Plan 13 剩余全部任务。分支 `claude/dada-mobile-ui-optimization-jgrc84`，基线 `6c94d0b` → 头部见 git log（18 个提交，47 文件，+4900/-660）。过期后删除本文件。

## 状态总览

| 任务 | 状态 | 说明 |
|---|---|---|
| Task 1 令牌/字体/控件 | ✅（上会话） | 双评审已过 |
| Task 2 分类点货双栏 | ✅ | 补课双评审完成；ProductRow 名称列 74→118px（星标入 meta 行、6rem 槽位）；右栏滚动位置跨导航重置修复 |
| Task 3 /buscar | ✅ | 搜索页 + localStorage 历史；生产 404 在本分支消除；收藏跨路由 revalidate、越界页码重定向 |
| Task 4 /cuenta | ✅ | 账号中枢；madridMonthStartIso + ACTIVE_ORDER_STATUSES；红卡三处文字 AA 修正（统计条 bg-black/10，5.69:1 实测） |
| Task 5 壳层 | ✅ | 底部四标签 TabBar + 黑色需求单条；旧红条+垫片退役；安全区 env() 总账全线闭合（120+S 尾垫片） |
| Task 6 /carrito | ✅ | 固定提交栏、两段式清空、乐观时钟统一、**需求单页步进器中心可键入**（整箱 24 件不再按 24 下）、阻断提示入栏 |
| Task 7 /pedidos | ✅ | 四标签、订单卡、查看详情、再来一单合并（纯函数 mergeReorderLines + 表测试）；读失败必 bail 不撒谎 |
| Task 8 perfil/direcciones/login | ✅ | 身份卡（codcli 走 guard 现有嵌入）、k/v 行、wash 卡；es 全量母语通读（8 处措辞修 + 键重命名） |
| Task 9 验证 | ✅ 静态半 | 净树门禁 889/27 全绿；跨任务终审零阻断；**动态半（真人登录走查）留给 owner**，见下 |

流程：每任务 = Opus(xhigh) 实现者 → 规格合规 + 代码质量并行双评审 → 裁决修复轮 → 复核，全部通过后推送。全部 18 个提交每个都过了五道门禁（bridge:build / lint / typecheck / test / build）。测试 811 → **889**（+78：search-history、nav-tabs、cartUnits、madridMonthStartIso、tab map、mergeReorderLines、parseReorderCount、sanitizeSearch `_`）。

## ⚠️ Owner 必办（本环境做不了的）

1. **真人登录走查（Task 9 动态半）**：`pnpm preview`，cliente-test 登录（帐密 `docs/comandos.md` §测试账号），390×844 走七屏 zh+es：01 目录（栏联动/步进器焦点/需求单条/角标）、02 需求单（备注/信息盒/固定栏/禁用与启用提交——**绝不按提交**）、03 继续加货往返、04 搜索（历史跨刷新持久）、05 我的（三统计是真数）、06 订单（标签/详情/再来一单→**清掉它填的车**）、07 perfil+direcciones。≥1024 桌面重走：头部图标行在、双栏在、无底栏。
2. **show_prices 矩阵**：staff/ajustes 开关来回，重看目录/搜索/需求单/黑条。黑条在关价时保留两个计数只去金额——这是唯一无夹具无实测的行为。
3. **真机安全区**：刘海 iPhone 竖屏确认底栏避开 home 条、目录最后一行和栏最后一个分类可达；横屏若在意，需要一轮 `px-[max(1rem,env(safe-area-inset-left))]`（终审预测项，非缺陷）。
4. **CCR 环境白名单加 `*.supabase.co`**：本容器出网被代理 403，全部浏览器验证只能用「临时夹具路由 + 真组件 + 常量数据」替代（每次提交前删除，git 无残留）。加了白名单，下个会话就能真登录验证。
5. **两个产品裁量**（终审建议，非缺陷）：es 底栏标签 `nav.tabCart`="Pedido" 与 "Mis pedidos" 只差单复数——可考虑改 "Mi pedido" 与 cart.title 一致；`favAdd/favRemove` aria 仍叫 收藏/favoritos 而界面词已是 常购/habituales（3:1），对齐是两行字。

## 已接受的既知状态（不是 bug）

- `/buscar` 列表尾 +102px 死滚动（sheet pb-36 + main 72+S 双重预留，计划自定数；站点注释已如实记账）。
- `/carrito` 继承 main 72+S 底衬而无底栏（它自己的固定提交栏要这空间）。
- 栏上 常购 计数（favorites 全量）与栏内 共 N 种（is_current_variant 过滤）可差 1——过时变体星标，热路径不值一次 join。
- staff 队列的 order_items 读与客户页同款无界形（客户页已改 order_id 优先排序 + limit 1000；staff 侧未动，下轮可同步）。
- 清空按钮 ≤4s 自愈的窄重臂窗口（注释已如实描述）；清空/删行后焦点落 body（预存在类问题）。
- 目录页三处 pre-baseline 的 faint 计数（`28c3489` 引入，在本范围外；若要一把扫，连同本轮四个 AA 先例一起）。
- zh `addresses.note` 只说地址而卡片已含姓名电话（zh 冻结，owner 裁量放宽为「资料有误…」）。

## 纪律与坑（沿用 + 新增）

- **生产红线**不变：绝不提交订单；验证不登录（本环境根本连不上）；夹具路由提交前必删并清 `.next`。
- 门禁五道全零才提交；提交尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session` 行。
- 注释承重：五轮修复中三轮的「复核者修正」都是抓注释数字失真（112px 从未清过、es 两行换行、45px 手机头）。改行为必同步改注释，数字必须自算。
- AA 压过 mockup 字面已成体系先例（chips → tab 标签 → 红卡小字 → 节标题 → 清除钮/菜单提示），`globals.css` 的 faint 许可文本是唯一裁判。
- 安全区总账：所有固定底部元素与所有让位余量要么带 `env()` 要么可证覆盖（终审 C 节有全表）；新固定元素照抄这套算术。
- Next 16：读 `AGENTS.md`；`searchParams` 是 Promise；middleware 在 `src/proxy.ts`。
- 安全基线未动：migrations/RPC/RLS/staff/package.json 全零 diff；`checkout.ts` 仅 6 行已审计的 clearCart 调用点变更。

## Git

- 本分支：`claude/dada-mobile-ui-optimization-jgrc84`（远端同步）。`main` 仍在 `6c94d0b`（含 Task 3 前的 404 过渡态）——**合并本分支即消除生产 404**；合并前 Vercel 生产不受影响。
- `dev` 分支仍在 6c94d0b 同点，未动。
