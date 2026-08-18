# DADA 桥接部署手册 / Manual de despliegue del puente

> 面向在 **ERP 服务器（SERVER）** 上操作的人。中文说明，命令原样照抄（Los comandos
> se copian tal cual; no traducir rutas ni parámetros）。
>
> 桥接是一个单文件 Node 程序 `dada-bridge.js`，只往外连：HTTPS → Supabase，本机
> SQL → Wingest。**不需要开放任何入站端口，不需要公网 IP。**

三个子命令，各自独占一把锁（`<命令>.lock`），跑完写一行心跳到 Supabase 的
`bridge_status`，员工后台首页的「桥接状态」卡片读的就是它。

| 命令 | 做什么 | 频率 |
| --- | --- | --- |
| `orders` | 认领门户里已确认的订单，注入 Wingest 成为 Pedido，把 NUMPED 写回门户 | 每 1 分钟 |
| `albaran-sync` | 查 `albfacca`，把已开出的 Albarán 号回写门户（订单变「已出单」） | 每小时 |
| `price-sync` | 读 `articulo` 的六档价 + 单位，合并进门户商品目录 | 每天一次 |

---

## ① 安装 Node（一次性）/ Instalar Node

在 SERVER 上装 **Node.js LTS（≥ 22）**，官方 MSI，一路下一步即可（默认会把
`node.exe` 加进系统 PATH）。装完在 CMD 里确认：

```
node --version
```

要求输出 `v22.x` 或更高。桥接的打包目标就是 node22，低版本会在启动时报语法错误。

> 桥接**不需要** npm install、不需要 `node_modules`、不需要 Git。整个程序就是
> 一个 `.js` 文件。

---

## ② 部署目录与 bridge.env / Carpeta y configuración

新建目录 `C:\dada\bridge\`，放两个文件：

```
C:\dada\bridge\
    dada-bridge.js      ← 我们提供的打包文件（唯一的程序）
    bridge.env          ← 配置，在服务器上手写，不进任何代码库
```

> **升级顺序不能颠倒**：本版本的桥接依赖数据库迁移中的失败状态 RPC，以及可回填的
> `CAN/EJE/NUMPED` 身份列、独立的 Albarán CAN/EJE 和五参数 `bridge_mark_injected`。发布人必须先按时间顺序应用
> 到 `20260817130000_historical_order_claim_scope.sql`，再替换门户和 `dada-bridge.js`；不要先把
> 新 JS 单独复制到旧数据库上。任务应在整个切换窗口保持停用，验证完成后再启用。

程序运行时产生的东西也都落在这个目录里：

```
    bridge.log          ← 日志（追加写）
    orders.lock         ← 运行中才存在的锁文件
    albaran-sync.lock
    price-sync.lock
```

> **为什么必须用绝对路径想这件事**：计划任务的默认工作目录是
> `C:\Windows\System32`。桥接是按**自己所在的目录**找 `bridge.env` 和写
> `bridge.log` 的，不是按工作目录——所以手动跑和计划任务跑读到的是同一份配置。

### bridge.env 模板

用记事本新建 `C:\dada\bridge\bridge.env`，内容如下（`#` 开头是注释，`KEY=VALUE`
每行一条，值里有 `=` 也没关系，只按第一个 `=` 分割）：

```ini
# ---- Supabase（门户侧）----
SUPABASE_URL=https://gudiykhngonoqsjoigza.supabase.co
# service_role 密钥：从保险库取，粘贴到这里。绝不写进代码库、聊天记录或截图。
SUPABASE_SERVICE_ROLE_KEY=<从保险库取>

# ---- Wingest（ERP 侧）----
# 两种写法，二选一，不能混用（详见下面的「⚠️ 主机名与端口」）：
#   SERVER,50352      端口直连（推荐）
#   SERVER\INSTANCIA  按实例名解析（端口会被忽略，需要 SQL Browser）
WINGEST_SERVER=SERVER,50352
# 沙箱 wg_test / 生产 wgdemo —— 上线切换时改这一行
WINGEST_DB=wg_test
WINGEST_USER=dada_bridge
WINGEST_PASSWORD=<从保险库取，切勿写真实密码进任何文档>

# ---- 业务参数（一般不动，留空即用默认值）----
# 盖在 pedido 上的 ERP 操作员，必须存在于 susuario.CODUSU，最长 4 位。
# 沙箱用 SFY；生产用哪个账号是上线前的一个决定，见第 ⑥ 节。
BRIDGE_ERP_USER=SFY
BRIDGE_CAN=B
BRIDGE_EJE=26
# 默认 false：orders 会把 EJE 与 Europe/Madrid 的当前年份核对，不一致就拒绝认领。
# 只有经批准补录历史年度的一张指定订单时才临时改 true；补录完立即恢复 false。
BRIDGE_ALLOW_HISTORICAL_EJE=false
# 仅当上项=true时填写那一张门户订单的 UUID；false 时本项必须删除/留空。
# BRIDGE_HISTORICAL_ORDER_ID=00000000-0000-4000-8000-000000000000
BRIDGE_ALM=00001
BRIDGE_SERFAC=1
# 一轮最多认领多少张订单（1–200）
CLAIM_LIMIT=20
# 认领租约秒数（30–3600）：进程崩溃或失败状态未写回时，过期后才允许重新认领
LEASE_SECONDS=300
```

配置错了会**立刻失败并说明是哪一项**（错误码形如 `MISSING_SUPABASE_URL`、
`BAD_WINGEST_SERVER`）。`orders` 还会在认领任何订单之前检查 `BRIDGE_EJE`：例如马德里
时间已经进入 2027 年而仍配置 `26`，会以 `EJE_YEAR_MISMATCH` 失败，不会把新订单静默
写回旧年度。

`SUPABASE_URL` 不是可自由更换的通用地址：程序只接受上面这一条本项目的
`https://gudiykhngonoqsjoigza.supabase.co` 根地址，拒绝 HTTP、其他项目、端口、路径、
URL 用户信息、查询参数和重定向。原因是每个请求都携带 service-role 密钥；配错目的地
必须在发出请求前失败关闭。

> ⚠️ **配置失败是唯一不写心跳的失败**：没有 `SUPABASE_URL` 和密钥就没法往
> `bridge_status` 写任何东西。这种情况下员工后台的卡片显示的是「未运行」，
> 真正的原因只在服务器的 `bridge.log` 里——见第 ⑦ 节。

### bridge.env 的 NTFS 权限与密钥轮换

`bridge.env` 同时含门户 service-role 和 SQL 密码。创建计划任务所用账号后，以管理员
CMD 执行；把 `SERVER\<账号>` 换成第 ③ 节 `/ru` 的同一个账号：

```bat
icacls "C:\dada\bridge" /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "SERVER\<账号>:(OI)(CI)M"
icacls "C:\dada\bridge" /inheritance:r
icacls "C:\dada\bridge\bridge.env" /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "SERVER\<账号>:R"
icacls "C:\dada\bridge\bridge.env" /inheritance:r
icacls "C:\dada\bridge\bridge.env"
```

⚠️ **顺序不能反**：`/inheritance:r` 是**删除**继承来的 ACE，不是转成显式 ACE。先
`/inheritance:r` 再 `/grant:r`，中间那一刻文件上一条 ACE 都不剩；必须先把三条显式
ACE 授上，再把继承删掉。

前两个 SID 分别是本机 Administrators 和 SYSTEM，避免西语/中文 Windows 的组名差异。
最后一条输出里不应再有普通 Users/Usuarios 或 Authenticated Users。任务账号必须能读
`bridge.env`，并能在目录里追加 `bridge.log`、创建锁文件；不需要管理员权限。

⚠️ 目录上的 `M`（Modify）含 `DELETE_CHILD`：任务账号对 `bridge.env` 本身只有 `R`，
但仍然可以在目录里**删掉并重建**这个文件。这是让它能写 `bridge.log`、建锁文件所付的
代价；真正的防线是这台机器只有运维和该服务账号能登录。

轮换任一密钥时：先 `/disable` 三个任务并用 `schtasks /end` 结束仍在运行的实例；先
生成新 `sb_secret_…` service-role 密钥或新的 SQL 登录密码，再原地更新
`C:\dada\bridge\bridge.env`，重新执行上面的文件 ACL，在维护窗口手动运行对应任务并
核对 Supabase/SQL 连接日志，最后撤销旧密钥并重新 `/enable`。不要复制出
`bridge.env.bak`；若需
回滚，只在密码保险库里保留旧凭据直到验证完成。

### ⚠️ `WINGEST_SERVER`：主机名与端口，二选一

两种写法**互斥**，写成一条会踩坑：

| 写法 | 怎么连 | 什么时候用 |
| --- | --- | --- |
| `SERVER,50352`（推荐） | TCP 直连到 50352 端口 | 端口固定、SQL Browser 关着——大多数加固过的 ERP 机器 |
| `SERVER\INSTANCIA` | 拿实例名去问 SQL Browser（UDP 1434）要端口 | 端口是动态的、且 SQL Browser 服务开着 |

🚫 **`SERVER\INSTANCIA,50352` 这种写法不要用。** 只要主机名里带反斜杠，驱动就
按"命名实例"处理并**把端口丢掉**（node-mssql 里就是一行
`if (cfg.options.instanceName) delete cfg.options.port`），于是它去走 SQL Browser
的 UDP 1434——而这个服务在加固过的服务器上通常是关的，表现为连接超时。

更容易被骗的是日志：`start` 那行是把主机和端口**重新拼起来**打印的，所以即使端口
已经被丢掉，日志里照样写着 `wingestServer=SERVER\INSTANCIA,50352`。**日志里有端口
≠ 真的用了那个端口。** 拿不准就用第一种写法。

用哪个端口不确定时，在 SERVER 上查（SQL Server 配置管理器 → TCP/IP → IP 地址 →
IPAll → TCP 端口），或者直接问 SQL：

```sql
SELECT local_tcp_port FROM sys.dm_exec_connections WHERE session_id = @@SPID;
```

结果显示 NULL 说明这条连接走的是共享内存或命名管道（在 ERP 机器本机用 SSMS 连
`localhost` 时就是这样），不代表没有 TCP 端口——改用上面的配置管理器路径查，
或用 `tcp:SERVER` 前缀强制走 TCP 再查一次。

桥接驱动强制开启 SQL Server TLS。当前 Wingest 使用内部/自签名证书，因此连接会加密，
但暂时信任服务器证书而不校验证书链；防火墙仍应只允许 ERP 服务器/桥接账号访问该 SQL
端口。安装企业 CA 签发且名称匹配的 SQL Server 证书后，应把代码中的
`trustServerCertificate` 收紧为 `false`。

---

## ③ 三个计划任务 / Tres tareas programadas

### ⏰ 服务器时钟：2026-08-18 起已是马德里时间

**SERVER 的 Windows 时钟自 2026-08-18 起改为马德里时间（Romance Standard
Time）**，和生意同一个时区。`schtasks /st` 用的是机器本地时间——现在就是
马德里时间，所以「每天早上 6:30 跑价格同步」直接写 `/st 06:30`，不再需要
任何换算。

> 📜 历史注记：2026-08-18 之前 SERVER 跑的是中国时间（UTC+8），当时的手册
> 让人把 06:30（马德里）写成服务器本地 12:30。如果在别处看到 12:30 的旧说法
> 或旧任务，那是时钟切换前的产物——按现在的马德里时钟，12:30 会落在午市
> 高峰，**必须**用 06:30 重建。
>
> 桥接程序本身不受时钟切换影响：业务日期一律经
> `AT TIME ZONE 'Romance Standard Time'` 换算，日志时间戳一律是 UTC。
> 订单注入（每分钟）和出货单回写（每小时）跟时区无关。
>
> ⚠️ 顺手检查一件事：SERVER 上**其他**按本地时间排程的任务（备份、ERP 夜间
> 作业）在时钟切换后全部平移了 6-7 小时，需要逐个核对重排。

### 三条创建命令

在 SERVER 上以**管理员身份**打开 CMD，把 `SERVER\<账号>` 换成真正跑这三个任务
的本地账号，然后逐条执行。`/rp *` 会提示你输入该账号的密码（密码只输入，不写进
任何文件）：

```
schtasks /create /tn "DADA Bridge Orders" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" orders" /sc minute /mo 1 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

```
schtasks /create /tn "DADA Bridge Albaran" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" albaran-sync" /sc hourly /mo 1 /st 00:10 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

```
schtasks /create /tn "DADA Bridge Prices" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" price-sync" /sc daily /mo 1 /st 06:30 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

要点：

- **`/tr` 里的引号**：整个命令行用一对外层引号包住，里面的路径引号写成 `\"`。
  路径里有空格（`Program Files`），漏了这层转义任务会启动失败。
- **必须存密码（`/rp`）**，不能用 `/np`：`/np` 的任务"只能访问本地资源"，桥接要
  走 HTTPS 出去连 Supabase。也不要加 `/it`（那样只有该用户登录时才跑，服务器上
  等于不跑）。
- `/ru` 用本地账号，不用 SYSTEM：连 ERP 用的是 SQL 账号密码（见 `bridge.env`），
  和 Windows 身份无关；用普通账号跑权限最小，出事也好查。
- `albaran-sync` 单独一个每小时的任务（`/sc hourly`）。它只读 `albfacca`、
  只写门户，跟每分钟的订单任务互不干扰；开单是人在 Wingest 界面上按按钮，一小时
  一次的回写足够了。
- `/f` 表示已存在同名任务就覆盖——重装时直接重跑这三条即可。

### 确认任务建对了

```
schtasks /query /tn "DADA Bridge Orders" /v /fo list
schtasks /query /tn "DADA Bridge Albaran" /v /fo list
schtasks /query /tn "DADA Bridge Prices" /v /fo list
```

看三件事：**下次运行时间**（Próxima ejecución）、**运行身份**（Ejecutar como
usuario）、以及 orders 那条的**重复间隔 1 分钟**。上面的命令没有传 `/et` 或
`/du`，所以重复是**没有结束时间**的——在任务计划程序界面里，"重复任务间隔：1 分钟"
后面跟的持续时间会显示成"无限期 / Indefinidamente"。看到这个才是对的。

### 手动跑（测试用）

任何时候都可以手动跑一次，锁保证它不会和计划任务撞车：

```
node C:\dada\bridge\dada-bridge.js --help
node C:\dada\bridge\dada-bridge.js orders
node C:\dada\bridge\dada-bridge.js albaran-sync
node C:\dada\bridge\dada-bridge.js price-sync
```

参数是严格的：必须**恰好一个**已知命令。写错、写多、不写都会打印用法并以 1 退出
（不写参数**不**等于 `--help`——否则一个漏了参数的计划任务会永远显示"成功"而
一张订单也没进过 ERP）。

---

## ④ 日志：在哪、健康的一轮长什么样 / Registro

日志就在程序旁边：**`C:\dada\bridge\bridge.log`**，同时也写到 stderr（手动跑时
直接在窗口里看得到）。一行一个事件，ISO 时间戳开头，可以直接用记事本打开、整段
复制粘贴到聊天里。

> service_role 密钥和 SQL 密码在写出前会被替换成 `***`——包括 mssql 或 fetch
> 自己抛出的错误消息。**粘贴日志是安全的。**

### 一轮健康的 orders（有一张订单）

```
2026-08-16T04:31:02.113Z INFO start job=orders dir=C:\dada\bridge supabaseUrl=https://gudiykhngonoqsjoigza.supabase.co wingestServer=SERVER,50352 wingestDb=wg_test wingestUser=dada_bridge erpUser=SFY can=B eje=26 allowHistoricalEje=false historicalOrderId=null alm=00001 serfac=1 claimLimit=20 leaseSeconds=300
2026-08-16T04:31:02.640Z INFO claimed claimToken=1f7c0f6e-6a2a-4f6b-9d3b-1a5b8e6d0c11 count=1
2026-08-16T04:31:04.902Z INFO injected orderId=9c1e0a52-3f42-4a6d-9b0f-1d2c3e4f5a6b orderNumber=1042 company="Wok Ciudad Lineal" codcli=1234 can=B eje=26 numped=8871 lineCount=7
2026-08-16T04:31:05.188Z INFO orders summary claimed=1 injected=1 recovered=0 failed=0 requeued=0 terminal=0 markFailed=0 failureMarkFailed=0 manualRequired=0 retryPending=0 processingPending=0 backlogCountError=0 ok=true
```

> `lineCount=7` 数的是**行数**（这张 pedido 写了 7 行 `pedclili`），**不是箱数、
> 也不是瓶数**。一行订了几箱看 `CAJ`、折成几个基本单位看 `CANSER`，两个都只在
> ERP 里看得到（第 ⑨ 节步骤 5 的查询）。找回（recovered）那条日志的
> `lineCount=0` 是约定：那一轮一行都没写，单子本来就在。

### 一轮健康的 orders（没订单——99% 的分钟长这样）

```
2026-08-16T04:32:02.061Z INFO start job=orders dir=C:\dada\bridge ...
2026-08-16T04:32:02.402Z INFO nothing to inject claimToken=2b8d1c33-...
2026-08-16T04:32:02.404Z INFO orders summary claimed=0 injected=0 recovered=0 failed=0 requeued=0 terminal=0 markFailed=0 failureMarkFailed=0 manualRequired=0 retryPending=0 processingPending=0 backlogCountError=0 ok=true
```

没订单时**不会**连 ERP——一分钟一次的任务不该为"没事干"开一条 SQL 连接。

### albaran-sync

```
2026-08-16T05:10:01.550Z INFO start job=albaran-sync dir=C:\dada\bridge ...
2026-08-16T05:10:02.771Z INFO albarán matched orderId=9c1e0a52-... can=B eje=26 numped=8871 numalb=4410
2026-08-16T05:10:02.980Z INFO albaran-sync summary injected=1 matched=1 marked=1 failed=0 ok=true
```

没有在等出货单时只有一行 `nothing awaiting an albarán`。

### price-sync

```
2026-08-16T04:30:01.204Z INFO start job=price-sync dir=C:\dada\bridge ...
2026-08-16T04:30:03.815Z INFO read articulo articles=3021
2026-08-16T04:31:40.002Z INFO progress applied=500 of=3021
2026-08-16T04:38:22.117Z INFO merged matched=2854 notInPortal=167 withAnyPrice=2790 syncedAt=2026-08-16T04:30:03.900Z sample=1-0001,1-0002,1-0007,2-0114,2-0115,3-0006,3-0007,4-0201,4-0202,4-0203,5-0011,5-0012,6-0044,6-0045,7-0100,7-0101,8-0033,8-0034,9-0007,9-0008
2026-08-16T04:38:29.640Z INFO price-sync summary articles=3021 matched=2854 notInPortal=167 fullyUnpriced=42 orderableWithPrice=2712 notInPortalSample="[\"1-0001\",\"1-0002\",\"1-0007\",\"2-0114\",\"2-0115\",\"3-0006\",\"3-0007\",\"4-0201\",\"4-0202\",\"4-0203\",\"5-0011\",\"5-0012\",\"6-0044\",\"6-0045\",\"7-0100\",\"7-0101\",\"8-0033\",\"8-0034\",\"9-0007\",\"9-0008\"]" ok=true
```

> ⏰ **日志时间戳一律是 UTC（结尾的 `Z`）**，不是马德里本地时间。马德里夏令时
> 比 UTC 快 2 小时、冬令时快 1 小时——对时间时先减 2（夏）/1（冬）小时再看。
> （上面的样例录制于 SERVER 还是中国时钟的时期：当时的本地 12:30 = 04:30Z；
> 2026-08-18 时钟切到马德里后，本地 06:30 的价格同步会以 **04:30Z（夏）/
> 05:30Z（冬）**出现在日志里。）

`notInPortal` 是 ERP 里有、门户里没有的编号数量；`sample=` 和
`notInPortalSample` 都列出**前 20 个**，用来判断那批到底是"ERP 自用的包材/服务
条目"还是"门户导入漏了一个品类"。两者内容一样、形式不同：`sample=` 是给人看的
逗号列表，`notInPortalSample=` 是发给门户状态卡片的那个 JSON 数组（数组里有引号，
所以整个值又被引起来、里面的引号带反斜杠——看着别扭，是正常的）。

price-sync 跑几分钟是正常的（三千多个商品，一个一个 PATCH）。

### 日志会一直变长

`bridge.log` 是**追加**写，不会自动轮转。当它大到不好打开时（比如超过 50 MB），
停一下三个任务，把文件改名成 `bridge.log.2026-08` 收着，程序下次运行会自动新建。
删掉也可以，不影响运行。

---

## ⑤ 最小权限 SQL 授权 / Permisos mínimos en SQL Server

沙箱阶段 `dada_bridge` 可以先挂 `db_owner` 图省事；**生产上线时换成下面这套**。
桥接只碰这些表，多一张都不需要。

在 SSMS 里对**生产库**执行（先把 `wgdemo` 和登录名核对一遍）：

```sql
-- 1) 登录名（若还没有）。密码从保险库取，不要留在脚本文件里。
--    CREATE LOGIN dada_bridge WITH PASSWORD = '<从保险库取>',
--        DEFAULT_DATABASE = wgdemo, CHECK_POLICY = ON;

USE wgdemo;
GO

-- 2) 数据库用户（若还没有）
--    CREATE USER dada_bridge FOR LOGIN dada_bridge;

-- 3) 只读：客户、商品、批次、税率、操作员、单据
GRANT SELECT ON dbo.clientes      TO dada_bridge;  -- codcli 校验、客户抬头
GRANT SELECT ON dbo.articulo      TO dada_bridge;  -- 行的商品数据 / price-sync 读价
GRANT SELECT ON dbo.stolot        TO dada_bridge;  -- FIFO 批次（未过期、VENDIBLE=1、真实可用量=CANT−开放pedido占用）
GRANT SELECT ON dbo.tipivaar      TO dada_bridge;  -- 税槽 POSMAT
GRANT SELECT ON dbo.iva           TO dada_bridge;  -- 税率（TIPIVACLI × TIPIVAART）
GRANT SELECT ON dbo.susuario      TO dada_bridge;  -- BRIDGE_ERP_USER 必须存在
GRANT SELECT ON dbo.albfacca      TO dada_bridge;  -- albaran-sync 查 NUMALB / idventa 防撞
GRANT SELECT ON dbo.albfacli      TO dada_bridge;  -- idlinea 防撞（与 pedclili 取并集的最大值）
GRANT SELECT ON dbo.pedclicah     TO dada_bridge;  -- 去重要同时查历史表

-- 4) 读 + 写：桥接自己写的三张单据表
GRANT SELECT, INSERT ON dbo.pedclica     TO dada_bridge;  -- 抬头（含去重查询、自检）
GRANT SELECT, INSERT ON dbo.pedclili     TO dada_bridge;  -- 明细行
GRANT SELECT, INSERT ON dbo.pedclica_adi TO dada_bridge;  -- 备料附表（estprepara=0）

-- 5) 读 + 改：单号计数器（NUMPEDCLI / IDVENTA / IDPEDCLILI）
GRANT SELECT, UPDATE ON dbo.newcontador  TO dada_bridge;

-- 6) 收回沙箱阶段图省事给的大权限。
--    先判断再退出：本来就不在 db_owner 里的话，直接 DROP MEMBER 会报一个红色
--    错误，让人以为整段脚本白跑了。
IF IS_ROLEMEMBER('db_owner', 'dada_bridge') = 1
    ALTER ROLE db_owner DROP MEMBER dada_bridge;
```

> 桥接**没有** DELETE、没有 UPDATE 现有单据、没有建表权限：它只会新增 Pedido、
> 只会把计数器 +1。ERP 里已经存在的任何一行，它都改不动。

授权后核对一遍：

```sql
SELECT o.name AS objeto, p.permission_name
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE USER_NAME(p.grantee_principal_id) = 'dada_bridge'
ORDER BY o.name, p.permission_name;
```

改完权限**必须手动跑一轮 `orders` 验证**（第 ③ 节的手动命令）。权限缺一张表的
表现是注入时抛 `permission was denied`，整张订单回滚、租约到期后重试——不会写坏
数据，但也永远进不了 ERP。

---

## ⑥ 上线切换清单 / Lista de comprobación para producción

按顺序做，每步做完在这里打勾：

- [ ] **`BRIDGE_ERP_USER` 定下来**：沙箱用的是 `SFY`。生产要用哪个 ERP 操作员
      （盖在 pedido 上、客户和业务都会看到）是**老板的决定**。值必须存在于
      `susuario.CODUSU`，最长 4 位；改完 `bridge.env` 后手动跑一轮验证——用户不
      存在的话注入会在事务提交前自检失败并整单回滚。
- [ ] **`WINGEST_DB` 从 `wg_test` 改成 `wgdemo`**（生产库）。改完确认
      `bridge.log` 的 `start` 行里 `wingestDb=wgdemo`。桥接在连上后会拿
      `DB_NAME()` 和配置比对，连错库会直接失败而不是往错的库里写单。
- [ ] **执行第 ⑤ 节的最小权限脚本**，并从 `db_owner` 里移除 `dada_bridge`。
- [ ] **`BRIDGE_EJE` 核对**（默认 26 = 2026 会计年度）。每次跨年要在第一张新订单
      被确认前改成新年度；程序会按 `Europe/Madrid` 核对并以 `EJE_YEAR_MISMATCH`
      失败关闭。不要为了消掉报警长期设置 `BRIDGE_ALLOW_HISTORICAL_EJE=true`。历史
      补录必须同时指定 `BRIDGE_HISTORICAL_ORDER_ID`，数据库只会认领该 UUID 对应的
      一张订单，不会把同队列的正常订单写入旧年度。
- [ ] **第一张订单人工盯着走完**：门户下单 → 员工确认 → 等一分钟 → 看
      `bridge.log` 的 `injected` 行 → 在 Wingest 里打开这张 Pedido，确认
      `NUMPEDCLI` 是 `PORTAL-<订单号>`、价格与门户一致、行数和批次正常 → 人工
      转成 Albarán → 下一个整点后确认门户订单变成「已出单」并带 numalb。
      > ⚠️ **「价格与门户一致」不等于两边的数字长得一样**：门户按**箱**卖、显示
      > 的是**每箱价**；Wingest 按基本单位记账，`PREVEN` 是**每瓶/每袋**的价，
      > `CANSER` 是瓶数、`CAJ` 才是箱数。要对的是**行金额**：
      > `SUBTOT = CANSER × PREVEN` 必须和门户那一行的金额一分不差（对照表和例子
      > 见第 ⑨ 节步骤 5）。
- [ ] **回滚方案确认可用**：出任何问题，先停任务，再查原因。

### 回滚（随时可用）

```
schtasks /change /tn "DADA Bridge Orders" /disable
schtasks /change /tn "DADA Bridge Albaran" /disable
schtasks /change /tn "DADA Bridge Prices" /disable
```

停掉之后：门户照常收单（订单停在「已确认」），ERP 里已经写进去的 Pedido 一张都
不会消失也不会重复。恢复用 `/enable`：

```
schtasks /change /tn "DADA Bridge Orders" /enable
```

> 停掉桥接期间积压的订单，在恢复后会按先进先出一轮轮补上（每轮最多
> `CLAIM_LIMIT` 张）。不需要人工干预。

---

## ⑦ 健康检查：员工后台的「桥接状态」卡片 / Estado del puente

员工后台首页有一张「桥接状态 / Estado del puente」卡片，三行，每个任务一行。
它读的是每轮结束时写进 Supabase `bridge_status` 的那一行心跳（一个任务一行，
后写覆盖先写）。

| 卡片显示 | 颜色 | 含义 | 该做什么 |
| --- | --- | --- | --- |
| **正常** | 绿 | 上一轮跑完了，后面跟着这一轮的数字 | 什么也不用做 |
| **上一轮还在跑** | 紫 | 锁生效：上一轮还没结束，这一轮主动退让（`LOCK_HELD`） | **不是故障**。下一轮（一分钟后）自动恢复 |
| **有订单等待重试** | 黄 | 程序跑完了，但至少一张订单失败并已安排退避重试 | 先看错误码；重复出现或最终变红再处理 |
| **有订单需人工处理** | 红 | 毒丸达到重试上限、永久错误，或 ERP/门户回写结果不确定 | 打开员工订单页的「注入失败」，按错误详情修数据后再点重入队 |
| **失败** | 红 | 这一轮没跑完（`RUN_FAILED` 等），旁边显示错误码 | 去服务器看 `bridge.log` 的同一时刻 |
| **未运行（可能未调度）** | 琥珀 | 有心跳，但太旧了：orders 超过 10 分钟 / albaran-sync 超过 3 小时 / price-sync 超过 26 小时 | 任务被停用了？服务器关机了？先看计划任务 |
| **未运行** | 琥珀 | 从来没有过心跳 | 程序没装、任务没建，**或 `bridge.env` 配置失败** |
| **桥接未部署** | 琥珀 | 三个任务一条心跳都没有 | 整套还没上线，或装错了机器 |

**要看数字，不要只看颜色。** 每行下面是那一轮的计数：

- `orders`：先显示本轮的`认领 / 已注入 / 已找回 / 失败 / 已安排重试 / 需人工处理 /
  回写失败 / 失败状态未写回`，再显示当前存量的`待人工处理 / 等待重试 / 处理中待确认 /
  积压统计失败`。后三类存量每分钟重新精确计数，所以一张 `bridge_failed` 订单不会在
  下一轮空跑后由红色误变绿色；计数本身失败也会红，而不是把“未知”当成 0。
  `回写失败`（markFailed）是最值得盯的一个：**pedido 已经写进 ERP 了，但门户没
  记上**。下一轮会重新认领、靠 `PORTAL-<订单号>` 去重找回同一张 ERP 单据，并把
  原单据的 `CAN + EJE + NUMPED` 一起回写；连续几轮不归零就要人工看。`需人工处理`
  （terminal）表示订单已进入 `bridge_failed`，不会再无限重试；`失败状态未写回`
  （failureMarkFailed）表示失败本身也没能可靠写回，必须查日志和租约。
- `albaran-sync`：`待出单 / 已匹配 / 已回写 / 身份或回写失败`。
  **`待出单`（injected）不是"这小时注入了几张"**，而是"此刻还有几张已进 ERP 的
  订单在等人开 Albarán"——它是这一轮去 `albfacca` 里查的那批单号的数量，人没开单
  它就一直是那个数。`已匹配` 是这轮查到已开单的，`已回写` 是成功写回门户的；
  正常情况下后两个相等，`已回写` 少于 `已匹配` 说明有订单状态被人改过（比如已
  取消），下一轮会自动重试。`身份或回写失败` 表示某张已注入订单缺
  `CAN/EJE/NUMPED`、Wingest 历史查询未找到对应单据，或 RPC 没有确认回写；
  Bridge 会先按 `PORTAL-<订单号>` 从 `pedclica`/`pedclicah` 回读真实身份，绝不拿当前年度猜值。
- `price-sync`：`ERP 商品 / 已匹配 / 门户缺少 / 无价格 / 可售有价`，外加前 20 个
  门户缺少的编号。

### 两个必须知道的坑

1. **「上一轮还在跑」会盖掉刚写的成功。** 心跳一个任务只有一行，后写覆盖先写：
   一轮跑得慢、下一轮被锁挡住，卡片就会从「正常」跳成「上一轮还在跑」，哪怕上
   一轮其实成功了。**所以紫色永远不是故障**，一分钟内会自己好。
2. **`bridge.env` 配置失败不会写任何心跳。** 没有 URL 和密钥就没法往
   `bridge_status` 写东西——这时卡片显示的是「未运行」，而不是「失败」。
   **卡片说"未运行"时，第一件事是去服务器看 `bridge.log`**，那里有确切的错误码
   （`MISSING_SUPABASE_SERVICE_ROLE_KEY`、`BAD_WINGEST_SERVER` 之类）。

---

## ⑧ 常见故障速查 / Problemas frecuentes

**卡片一直显示「上一轮还在跑」，超过几分钟**
先区分“慢”与“死”。`/disable` 只阻止下次调度，**不会结束已经运行的 node**；不要
停用后立刻删锁。按顺序执行：

```bat
schtasks /change /tn "DADA Bridge Orders" /disable
schtasks /end /tn "DADA Bridge Orders"
type "C:\dada\bridge\orders.lock"
tasklist /fi "PID eq <把锁文件里的 pid 填这里>"
```

只有 `tasklist` 确认该 PID 已不存在后，才删除日志 `path=` 指向的那一个 lock，再启用
任务。新锁带随机 ownership token；旧进程的 `release` 会重新核对 token，绝不会删掉
后来实例的锁。同机 PID 仍存活或权限导致无法判断时，即使超过 30 分钟也会 fail-closed，
不会强抢。若硬崩溃恰好留下 `orders.lock.mutation-<哈希>`，先确认没有任何 Bridge node
进程，再观察 `orders.lock.mutation-*`。这类 sidecar 只覆盖「重读并删除主锁」这几毫秒，
所以它有自己的 **1 分钟** TTL（不是主锁的 30 分钟），新进程会安全回收过期 sidecar；
不要对整个目录使用通配删除。

**日志里 `codart … is not weighed but has fractional qty …`（`BAD_QTY_STEP`）**
这行商品是在**下单之后**才被标成称重的（或称重标志后来被关掉了），订单行上的
快照和商品当前的标志对不上，桥接按快照拒收、整单不写。处理：在员工后台的
确认队列里把这一行的数量**重新保存一次**——保存动作会把快照刷新成当前标志
（2026-08-17 起），下一轮自动重新认领注入。连续多轮不消失再贴日志回来。

**日志里 `mark_injected returned false — pedido exists, portal not updated`**
ERP 里单子写成功了，门户没记上（租约过期或订单被人改过）。下一轮会自动重试并
靠去重找回同一个 `CAN + EJE + NUMPED`，不会写出第二张 Pedido。恢复不会只信
`PORTAL-<订单号>`：还会核对 `CODCLI`、included 行数（在 `pedclili`/`pedclilih` 里
真数一遍，不看表头的 `ULTLIN`）和 `NETO` 分币金额；任一不符就
以 `ERP_PEDIDO_RECOVERY_MISMATCH` 失败关闭，防止把手工同名 Pedido 认成门户订单。
连续多轮不消失才需要人工处理。

**日志里 `ERP_COMMIT_OUTCOME_UNKNOWN` / `ERP_ROLLBACK_FAILED`**
这轮无法证明 SQL Server 的事务最终状态，当前连接已被判为不安全。程序会立即停止
使用该连接，把同批尚未尝试的订单以 `BATCH_ABORTED_UNSAFE_ERP_CONNECTION` 重排，
关闭连接并把整轮标红；下一轮先走上面的严格去重恢复，因此不要手工复制 Pedido。
先查 ERP 中该 `PORTAL-<订单号>`，再查网络/SQL Server 日志。

**日志里 `injected orders without a complete ERP identity`**
门户里有订单是 `injected` 状态却缺少 `CAN`、`EJE` 或 `NUMPED`——Albarán 同步会先
用 `PORTAL-<订单号>` 查询 `pedclica`/`pedclicah` 并通过受限 RPC 回填真实身份；查不到
或回填失败时才保留在 `failed` 计数中。它不会猜当前年度，以免跨年后把同号单据配错。
如果某张订单身份齐全、ERP 里也确实出了 Albarán，却一直停在 `injected` 配不上，
先查 `albfacca.CAN`：本作业按 Pedido 的 `CAN` 过滤（DADA 只有一个渠道 `B`），
换渠道开出的 Albarán 永远匹配不上，症状就是状态一直不动、没有错误。

**日志里 `EJE_YEAR_MISMATCH`**
`BRIDGE_EJE` 和马德里当前年份不一致，`orders` 已在认领前停止。正常跨年：把
`BRIDGE_EJE` 改为新年度后重跑。不要只打开全局旁路：历史补录必须按下面的单单流程，
同时绑定目标订单 UUID。

**补录一张历史年度订单（受控旁路）**

1. 停用 `DADA Bridge Orders`，并确认当前运行实例已经结束；不要让计划任务和手动命令
   同时运行。
2. 先确认目标订单不是 `bridge_failed`。认领谓词只接受 `confirmed`（且退避时间已到）
   和租约过期的 `processing`；`BRIDGE_HISTORICAL_ORDER_ID` 只是把认领**缩小**到这一
   张单，并不能认领终态订单。如果它显示「注入失败 / 需要人工处理」，先让员工在后台
   点「重新排队」，否则这一轮的 `claimed count` 会是 0，看起来像旁路没生效。
3. 核对目标门户订单的 UUID，而不是页面上的递增订单号。设置旧 `BRIDGE_EJE`、
   `BRIDGE_ALLOW_HISTORICAL_EJE=true` 和
   `BRIDGE_HISTORICAL_ORDER_ID=<该订单UUID>`。
4. 手动只跑一轮 `node C:\dada\bridge\dada-bridge.js orders`；日志的 `claimed count`
   最多只能是 1，并且 `orderId` 必须正好等于目标 UUID。
5. 在 ERP 和门户核对该单的 `CAN + EJE + NUMPED`。
6. 立即恢复当前 `BRIDGE_EJE`、把开关改回 `false`、删除
   `BRIDGE_HISTORICAL_ORDER_ID`，再启用计划任务。程序会拒绝“开关与 UUID 只填一个”
   的配置。

**员工订单页出现「注入失败 / 需要人工处理」**
这张订单已经停止自动重试。先按卡片上的错误码和消息修正商品、客户或配置，再点
「重新排队」；重入队会清空本轮失败计数并回到已确认队列。不要在原因未修好时反复
点，否则只会再次进入同一终态。原始错误消息只对员工可见，客户只看到需要人工处理。
如果这张单 ERP 永远不会收（商品已删、客户已停用），同一行也可以直接**取消**——
取消会连同失败计数和错误码一起清空，历史仍留在订单事件里。

**手动跑得好好的，计划任务却失败**
九成是 `/tr` 的引号转义（见第 ③ 节）或者运行账号没有 `C:\dada\bridge\` 的写权限
（写不了 `bridge.log` 和锁文件）。`schtasks /query /v /fo list` 里的"上次结果"
配合 `bridge.log` 一起看。

**price-sync 跑到一半停了**
日志里会写到第几个商品（`position=1234/3021`）。合并是按编号幂等的，直接重跑
一次即可，不会重复计价。

---

## ⑨ 沙盒测试 / Prueba en sandbox

上线前的一次性全链路验收：门户里一笔真实的**已确认**订单 → 沙盒库 `wg_test` 里
的一张 Pedido → 在 Wingest 界面转成 Albarán → 门户显示「已出单」。

> **只碰 `wg_test`。生产库 `wgdemo` 全程零写入。**
>
> 分工：**命令都在 SERVER 上由你跑**（RustDesk 过去即可），每一步把窗口里的输出
> **整段**贴回来；门户那头（播种订单、核对结果）我们来做。
>
> 门户是**同一套线上门户**，沙盒的只是 ERP 这一头。所以这是测试账号下的一笔真
> 订单，跑通之后它真的会变成「已出单」。
>
> 本节的步骤按 **1–8** 编号，和上面各节的 ①–⑧ 不是一回事；文中提到「第 ② 节」
> 之类指的是上面的章节。

### 开始之前 / Requisitos

- [ ] SERVER 上已装 Node ≥ 22（第 ① 节），目录 `C:\dada\bridge\` 已建好。
- [ ] **门户里已经有一笔「已确认」的订单**——控制器提前用测试账号下单并在员工后台
      确认。你不用在门户上做任何事，只需要知道它的**订单号**和**客户号 codcli**
      （我们会告诉你）。
- [ ] 这个 codcli 在 `wg_test` 的 `clientes` 里存在。不存在的话注入会在写任何东西
      **之前**失败（`PREFLIGHT_FAILED … clientes has no CODCLI …`）。先确认一下：

```sql
SELECT CODCLI, TARCLI, RTRIM(TIPIVACLI) AS TIPIVACLI, RTRIM(regiva) AS regiva
FROM dbo.clientes WHERE CODCLI = 990001;   -- 换成这笔订单的客户号
```

- [ ] Wingest 能打开沙盒公司——沙盒入口当初摘掉了，怎么加回来见**步骤 6**。

### 1）把两个文件拷到 SERVER

开发机上的这两个文件：

```
F:\DADA Distribucion\DADA\bridge\dist\dada-bridge.js
F:\DADA Distribucion\DADA\bridge\bridge.env.sandbox
```

拷到 SERVER 的 `C:\dada\bridge\`，**第二个要改名成 `bridge.env`**：

```
C:\dada\bridge\dada-bridge.js
C:\dada\bridge\bridge.env
```

程序是按**自己所在目录**找 `bridge.env` 的（第 ② 节），名字不对会直接报
`MISSING_BRIDGE_ENV`。拷完先空跑一次确认文件没坏：

```
node C:\dada\bridge\dada-bridge.js --help
```

### 2）填两个密钥

用记事本打开 `C:\dada\bridge\bridge.env`，把两处 `<...>` 换成真值：

| 这一行 | 填什么 |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY=` | 门户的 service_role 密钥（从保险库取） |
| `WINGEST_PASSWORD=` | SQL 登录 `dada_bridge` 的密码 |

其余各行沙盒值已经填好了（`WINGEST_SERVER=SERVER,50352`、`WINGEST_DB=wg_test`、
`WINGEST_USER=dada_bridge`），不用动。一行一条、不加引号、密钥不要换行。
**填好的 `bridge.env` 不要外传、不要截图。**

### 3）订单已经在等着了（前置条件，不用你做）

控制器在门户里下单并在员工后台点了「确认」，订单此刻是「已确认」状态。桥接只认领
这个状态的订单——所以这一步不用你操作，只要它没做，第 4 步就会是 `claimed=0`。

### 4）手动跑一次 orders

```
node C:\dada\bridge\dada-bridge.js orders
```

**把窗口里的输出整段贴回来。** 期待看到 `claimed … count=1`、一行
`injected … can=B eje=26 numped=<单号>`，最后 `orders summary claimed=1 injected=1 recovered=0
failed=0 requeued=0 terminal=0 markFailed=0 failureMarkFailed=0 ok=true`（健康输出的样子见
第 ④ 节）。同样的内容也追加在
`C:\dada\bridge\bridge.log` 里，密钥在写出前已经打码，**贴日志是安全的**。

### 5）在 SQL 里验证

在 SERVER 上开 CMD（密码不写进命令行，回车后 sqlcmd 会提示输入）：

```
sqlcmd -S SERVER,50352 -d wg_test -U dada_bridge -W -s " | "
```

把下面整段粘进去，最后单独一行 `GO` 回车：

```sql
SELECT TOP 5 z.ORIGEN, z.EJE, z.NUMPED, RTRIM(z.NUMPEDCLI) AS NUMPEDCLI, z.CODCLI,
       z.FECPED, z.FECENT, RTRIM(z.ESTPED) AS ESTPED, z.ALBARAN, z.NETO, z.TOTPED
FROM (
  SELECT CAST('pedclica' AS varchar(10)) AS ORIGEN, EJE, NUMPED, NUMPEDCLI, CODCLI,
         FECPED, FECENT, ESTPED, ALBARAN, NETO, TOTPED
  FROM dbo.pedclica  WHERE CAN='B' AND NUMPEDCLI LIKE 'PORTAL-%'
  UNION ALL
  SELECT CAST('pedclicah' AS varchar(10)), EJE, NUMPED, NUMPEDCLI, CODCLI,
         FECPED, FECENT, ESTPED, ALBARAN, NETO, TOTPED
  FROM dbo.pedclicah WHERE CAN='B' AND NUMPEDCLI LIKE 'PORTAL-%'
) z ORDER BY z.EJE DESC, z.NUMPED DESC;
GO
SELECT RTRIM(c.NUMPEDCLI) AS NUMPEDCLI, c.NUMPED, l.NUMLIN, RTRIM(l.CODART) AS CODART,
       l.CANPED, l.CANSER, l.PREVEN, l.SUBTOT, RTRIM(l.CODLOT) AS CODLOT, l.CAJ
FROM dbo.pedclica c
JOIN dbo.pedclili l ON l.CAN=c.CAN AND l.EJE=c.EJE AND l.NUMPED=c.NUMPED
WHERE c.CAN='B' AND c.NUMPEDCLI LIKE 'PORTAL-%'
ORDER BY c.NUMPED DESC, l.NUMLIN;
GO
```

要看的五件事：

1. `NUMPEDCLI` = `PORTAL-<门户订单号>`，`CAN + EJE + NUMPED` 和第 4 步日志里的三个
   身份字段一致；
2. `ESTPED='Abierto'`、`ALBARAN=0`（还没转单）；
3. `FECPED` / `FECENT` 是**马德里当天且时分秒 00:00:00**（带时分秒的单 Wingest
   的转换工具选不出来，这是当初踩过的坑）；
4. 每一行 **`CANSER = CANPED` 且 > 0**，`CODLOT` 是 FIFO 挑的批次（无批次商品为空
   是正常的）；
5. **数量和箱数是两列，别混着看**（2026-08-16「按箱下单」之后的规则）：

   | 列 | 应该是什么 |
   | --- | --- |
   | `CAJ` | **箱数**——客户在门户上填的那个数，原样落进来 |
   | `CANPED` / `CANSER` | **箱数 × `UNILOT`**，即瓶/袋这种基本单位的数量 |
   | `PREVEN` | **每个基本单位**的价（门户存的就是它，桥接一分钱不动） |
   | `SUBTOT` | `CANSER × PREVEN`，**必须等于门户那一行的金额，一分不差** |
   | `UNILOT` | `articulo.UNILOT`，ERP 自己的包装数（门户的箱容量是它的夜间副本） |

   真实的例子：门户上 `1-001` 是 `CAJA×24`、每箱 23,04 €，客户要 **2 箱**——

   ```
   CAJ = 2        CANPED = CANSER = 48   (2 × 24)
   PREVEN = 0,96  (每瓶，不是每箱)       SUBTOT = 46,08  (48 × 0,96)
   ```

   **门户的每箱价 × 箱数（23,04 × 2 = 46,08）必须和 `SUBTOT` 完全相等。** 对不上
   就是门户和 ERP 对「一箱几瓶」的理解不一致；这种单子桥接在提交前自检就会拦下来
   （日志里是 `CONTRATO: SUBTOT …`），**整单回滚，ERP 里一行都不会留**。

   > 2026-08-16 之前注入的单（例如 albarán 5992）写的是 `CAJ=1、CANSER=2`——那是
   > 这次要修掉的老行为，**不要拿它当参照**。参照是员工手写的行：
   > `CAJ=5、CANSER=120、PREVEN=0,99`（5 箱 × 24 瓶）。

> 完整版查询（多带计数器、单位、批次有效期，以及转单后归档到 `pedclicah` /
> `pedclilih` 的那一半）在代码库里：`scripts/wingest/verify-sandbox-pedido.sql`，
> 只读，可以整个文件在 SSMS 里打开跑。

**把查询结果也贴回来。**

### 6）在 Wingest 界面里转成 Albarán

沙盒公司入口在 2026-08-13 之后是摘掉的（`WG_EMPRESAS.dbo.empresas` 只剩 `wgdemo`
一行），要先加回来：

```sql
INSERT INTO WG_EMPRESAS.dbo.empresas (nomdb, des) VALUES ('wg_test', 'SANDBOX TEST');
```

- ⚠️ 这张表**所有工作站共用**：加回去之后别人也会看到「SANDBOX TEST」这个公司。
  挑个没人下单的时段做，**测完立刻删掉**：

```sql
DELETE FROM WG_EMPRESAS.dbo.empresas WHERE nomdb = 'wg_test';
```

- Wingest 里 `Archivo > Cambiar empresa` 切到 SANDBOX TEST。公司选择框上那个
  「No mostrar más esta pantalla」勾过之后会直接进上次的公司——当初切不过去就是
  它。
- **认标题栏**：沙盒是 `… / Empresa de Ejemplo`，生产是 `… / DADA UNIVERSAL S.L`。
  看到 DADA UNIVERSAL 就是切错了，立刻退出，什么都别按。
- 打开步骤 5 查到的那张 pedido（`NUMPEDCLI = PORTAL-<订单号>`），用**单据表单上的
  「Albarán」按钮**转换——2026-08-13 和 08-14 两张验证单走通的就是这条路；批量转换
  那个入口当时会无声中止，不要用。
- 转换后会弹「Impresión de albaranes」打印框，点 **Salir** 就行。
- 转换成功后 **pedido 会从 `pedclica` 消失、归档进 `pedclicah`
  （`ESTPED='Servido Total'`）**。再跑一次步骤 5 的第一段查询，那张单会出现在
  `pedclicah` 那一半——**查不到反而是成功的特征**，不是丢单。
- 把新的 **Albarán 号**记下来贴回来。

### 7）手动跑一次 albaran-sync

```
node C:\dada\bridge\dada-bridge.js albaran-sync
```

**输出整段贴回来。** 期待 `albarán matched orderId=… can=B eje=26 numped=… numalb=…`，最后
`albaran-sync summary injected=1 matched=1 marked=1 failed=0 ok=true`。

### 8）门户核对（我们来看，你不用操作）

- 客户端「我的订单」和员工后台「全部」标签里，这笔订单显示 **已出单**，并带
  `ERP 单号 <numped>` 和 `送货单号 <numalb>`，两个号和你贴回来的一致。
- 员工后台首页「桥接状态」卡片（第 ⑦ 节）：**订单注入**和**出货单回写**两行是绿色
  「正常」，下面带这两轮的计数。**「价格同步」那行显示「未运行」是正常的**——沙盒
  里根本没跑过它。
- 三样都对上，Task 4 收工。

### 收尾 / Al terminar

- 删掉 `empresas` 里的 `wg_test` 行（步骤 6 的 DELETE），别让员工再看到沙盒公司。
- `C:\dada\bridge\` 里的东西可以留着：上线时按第 ⑥ 节的清单把 `WINGEST_DB` 改成
  `wgdemo`、重新确认 `BRIDGE_ERP_USER`、跑第 ⑤ 节的最小权限脚本、再建第 ③ 节的三个
  计划任务即可。**但 `bridge.env` 里有真实密钥，不要复制到别处、不要留副本。**

### 如果不对 / Si algo falla

| 看到什么 | 多半是什么 | 怎么办 |
| --- | --- | --- |
| 连不上 SQL、`ConnectionError`、超时 | `WINGEST_SERVER` 的写法 | 见第 ② 节「⚠️ `WINGEST_SERVER`」：必须是 `SERVER,50352`，**不要**用带反斜杠的实例名 |
| `Login failed for user 'dada_bridge'` | 密码或用户名不对 | 核对 `WINGEST_PASSWORD` / `WINGEST_USER`；拿同一对账号密码在 SSMS 里连一次 `wg_test` 验证 |
| `claimed=0` / `nothing to inject` | 门户里没有「已确认」的订单 | 那笔订单确认了吗？还是上一轮已经把它认领走了（状态变「处理中」）？等 60 秒（`LEASE_SECONDS`）再跑一次 |
| `mark_injected returned false` / `markFailed=1` | **可报警**：pedido 已经进 ERP，门户没记上 | 把整段日志贴回来。下一轮会靠 `PORTAL-<订单号>` 去重找回同一组 `CAN + EJE + NUMPED` 重试，**不会写出第二张单** |
| `EJE_YEAR_MISMATCH` | `BRIDGE_EJE` 仍是上一年度（或服务器日期异常） | 先核对服务器日期和马德里年份；正常跨年就更新 `BRIDGE_EJE`。补录历史单必须按第 ⑧ 节的受控流程，同时绑定 `BRIDGE_HISTORICAL_ORDER_ID` |
| `clientes has no CODCLI …` | `wg_test` 里没有这个客户 | 见「开始之前」：换一个沙盒里真实存在的客户重新播种，或在沙盒里建这个客户 |
| `articulo has no CODART "…"` | 门户里的某个商品在 `wg_test` 里没有 | 贴回来，控制器换一笔只含 Wingest 有的商品的订单重新播种 |
| 任何 `CONTRATO:` 开头的行 | 提交前自检没过，**整单已回滚**，ERP 里什么都没留下 | 整行贴回来（`usuario … no existe` 是 `BRIDGE_ERP_USER` 的问题；`SUBTOT …` 是门户和 ERP 对「一箱几瓶」不一致，见步骤 5） |

其它症状先查第 ⑧ 节「常见故障速查」。拿不准就把 `bridge.log` 里对应时间的那几行
整段贴回来——密钥已打码。
