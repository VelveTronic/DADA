# 测试命令速查 / Chuleta de comandos

> 日常测试用的全部命令。桥接细节见 [bridge-runbook.md](bridge-runbook.md)；
> 部署见仓库 README 的 "Deploying to Vercel" 一节。

## ① 桥接（OSCAR 或 SERVER，`C:\dada\bridge`）

```text
node C:\dada\bridge\dada-bridge.js --help          # 空跑检查
node C:\dada\bridge\dada-bridge.js orders          # 注入已确认订单
node C:\dada\bridge\dada-bridge.js albaran-sync    # 回写出货单号
node C:\dada\bridge\dada-bridge.js price-sync      # 同步价格 + 箱数系数 + 称重(KG)标志
```

日志密钥自动打码，整段粘贴是安全的。改过桥接代码后必须重拷
`bridge/dist/dada-bridge.js`（开发机 `F:\DADA Distribucion\DADA\bridge\dist\`）。

## ② 沙盒公司入口（Wingest 公司选择器里的 SANDBOX TEST）

显示（整块贴 PowerShell，提示时输 dada_bridge 密码）：

```powershell
$sec = Read-Host "dada_bridge password" -AsSecureString; $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)); $cn = New-Object System.Data.SqlClient.SqlConnection("Server=SERVER,50352;Database=wg_test;User ID=dada_bridge;Password=$pw"); $cn.Open(); $cmd = $cn.CreateCommand(); $cmd.CommandText = "INSERT INTO WG_EMPRESAS.dbo.empresas (nomdb, des) VALUES ('wg_test','SANDBOX TEST')"; try { [void]$cmd.ExecuteNonQuery(); "SANDBOX visible" } catch { "fallo: " + $_.Exception.Message }; $cn.Close()
```

隐藏（测完必跑）：

```powershell
$sec = Read-Host "dada_bridge password" -AsSecureString; $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)); $cn = New-Object System.Data.SqlClient.SqlConnection("Server=SERVER,50352;Database=wg_test;User ID=dada_bridge;Password=$pw"); $cn.Open(); $cmd = $cn.CreateCommand(); $cmd.CommandText = "DELETE FROM WG_EMPRESAS.dbo.empresas WHERE nomdb='wg_test'"; "SANDBOX oculto: " + $cmd.ExecuteNonQuery(); $cn.Close()
```

Wingest 里 `Archivo > Cambiar empresa` 切换；**沙盒标题栏 = Empresa de Ejemplo**，
看到 DADA UNIVERSAL 就是生产公司，立刻退出。转单用**单据表单上的 Albarán 按钮**
（批量入口会无声中止），打印框点 Salir。

## ③ 验证注入结果（最近 5 张门户单 + 最新一张的明细）

```powershell
$sec = Read-Host "dada_bridge password" -AsSecureString
$pw  = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
$cn  = New-Object System.Data.SqlClient.SqlConnection("Server=SERVER,50352;Database=wg_test;User ID=dada_bridge;Password=$pw")
$cn.Open()
"=== ultimos pedidos PORTAL-* (activos) ==="
$da = New-Object System.Data.SqlClient.SqlDataAdapter("SELECT TOP 5 RTRIM(NUMPEDCLI) AS NUMPEDCLI, NUMPED, CODCLI, FECENT, RTRIM(ESTPED) AS ESTPED, NETO, TOTPED FROM dbo.pedclica WHERE CAN='B' AND NUMPEDCLI LIKE 'PORTAL-%' ORDER BY NUMPED DESC", $cn)
$t = New-Object System.Data.DataTable; [void]$da.Fill($t); $t | Format-Table -AutoSize
"=== lineas del mas reciente ==="
$da2 = New-Object System.Data.SqlClient.SqlDataAdapter("SELECT l.NUMPED, RTRIM(l.CODART) AS CODART, l.CAJ, l.CANSER, l.PREVEN, l.SUBTOT, RTRIM(l.CODLOT) AS CODLOT FROM dbo.pedclili l WHERE l.CAN='B' AND l.NUMPED = (SELECT MAX(NUMPED) FROM dbo.pedclica WHERE CAN='B' AND NUMPEDCLI LIKE 'PORTAL-%') ORDER BY l.NUMLIN", $cn)
$t2 = New-Object System.Data.DataTable; [void]$da2.Fill($t2); $t2 | Format-Table -AutoSize
$cn.Close()
```

- 已转 Albarán 的单会**从活动表消失**（归档进 `pedclicah`）——查不到反而是成功。
  想看历史，把第一段查询里的 `dbo.pedclica` 换成 `dbo.pedclicah`。
- 核对口诀：普通行 `CAJ`=箱数、`CANSER`=箱数×每箱只数；**称重行 `CAJ=0`、
  `CANSER`=公斤数**；两种行都必须 `SUBTOT = CANSER × PREVEN` = 门户行金额。
- 完整版（含计数器、批次效期）：`scripts/wingest/verify-sandbox-pedido.sql`
  （SSMS 里连 wg_test 打开执行，纯只读）。

## ④ 门户本地（开发机 `F:\DADA Distribucion\DADA`）

```text
pnpm dev                      # 开发模式
pnpm build && pnpm start      # 生产构建（分开跑也行）
$env:PERF_LOG=1; pnpm start   # 带性能日志（[perf] 行在本窗口打印）
pnpm test                     # 全部单元测试
```

## ⑤ 账号与建号

| 用途 | 邮箱 | 密码 |
| --- | --- | --- |
| 超级管理员 | `staff-test@dada.local` | `6eM8upQnSYYR6agJMq8C` |
| 测试餐厅（codcli=3 沙盒用） | `cliente-test@dada.local` | `J68Zbacpa7BWb6e2RhtL` |

建号：员工后台「用户管理」页面，或命令行：

```text
pnpm user:create staff <邮箱> <密码> <显示名> owner
pnpm user:create customer <邮箱> <密码> <显示名> <公司名> <codcli> <tarcli>
```

## ⑥ 完整测试一圈

1. 门户下单（测试餐厅）→ 2. 员工确认（称重行先在队列里改实际公斤数）→
3. `orders` → 4. ③号脚本核对 → 5. Wingest 转 Albarán（②显示入口）→
6. `albaran-sync` → 7. 门户「已出单」+ 后台首页状态卡 → 8. ②隐藏入口。

## ⑦ 上线前遗留清单

- 测试公司 codcli 目前指向 **3**（沙盒验证用）；割接前改回独立测试号或解除链接。
- 可疑箱数系数商品已停用待核（2-006 / 9-018 / 9-087 / 9-097 / 9-100）：Wingest
  里改好 UNILOT → `price-sync` → 商品管理里重新上架。
- 割接步骤：`bridge-runbook.md` 第 ⑥ 节（wgdemo 切换、最小权限脚本、三个计划任务）。
