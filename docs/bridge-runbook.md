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
# 形式：主机 或 主机,端口 或 主机\实例名。逗号形式是 SQL Server 客户端写法，
# 桥接会自己拆成 host + port（tedious 不认识 "host,port"）。
WINGEST_SERVER=SERVER\<实例名>,50352
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
BRIDGE_ALM=00001
BRIDGE_SERFAC=1
# 一轮最多认领多少张订单（1–200）
CLAIM_LIMIT=20
# 认领租约秒数（30–3600）：注入失败的订单等这么久后自动回到可认领状态
LEASE_SECONDS=300
```

配置错了会**立刻失败并说明是哪一项**（错误码形如 `MISSING_SUPABASE_URL`、
`BAD_WINGEST_SERVER`），不会带着半个配置去写 ERP。

> ⚠️ **配置失败是唯一不写心跳的失败**：没有 `SUPABASE_URL` 和密钥就没法往
> `bridge_status` 写任何东西。这种情况下员工后台的卡片显示的是「未运行」，
> 真正的原因只在服务器的 `bridge.log` 里——见第 ⑦ 节。

---

## ③ 三个计划任务 / Tres tareas programadas

### ⏰ 先记住这件事：服务器的时钟是中国时间

**SERVER 的 Windows 时钟跑的是中国时间（UTC+8），而生意跑在马德里时间。**
`schtasks /st` 用的是**机器本地时间**，也就是中国时间。

所以「每天早上 6:30（马德里）跑价格同步」这条要求，落到命令里是
**服务器本地 12:30**：

| 服务器本地（UTC+8） | UTC | 马德里 |
| --- | --- | --- |
| 12:30（夏令时期间） | 04:30 | **06:30 CEST** |
| 12:30（冬令时期间） | 04:30 | **05:30 CET** |

中国不实行夏令时，所以服务器 12:30 永远等于 UTC 04:30；马德里那头随夏冬令时
在 06:30 / 05:30 之间摆动。**两个时间都在营业前的清晨，都可以接受。**

> 🚫 **不要"顺手修正"成 06:30。** 把 `/st` 写成 06:30 会变成马德里午夜 00:30
> （夏令时）——那是备份和 ERP 夜间作业的时段。这里的 12:30 是对的。
>
> 订单注入（每分钟）和出货单回写（每小时）跟时区无关，不受这条影响。

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
schtasks /create /tn "DADA Bridge Prices" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" price-sync" /sc daily /mo 1 /st 12:30 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
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
usuario）、以及 orders 那条的**重复间隔 1 分钟**。Windows 会把 `/sc minute` 建成
"每天在起始时刻触发、之后每 1 分钟重复"的形式——在任务计划程序界面里看到
"重复任务间隔：1 分钟，持续时间：1 天"是正常的，第二天会自动重新开始。

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
2026-08-16T04:31:02.113Z INFO start job=orders dir=C:\dada\bridge supabaseUrl=https://gudiykhngonoqsjoigza.supabase.co wingestServer=SERVER\WINGEST,50352 wingestDb=wg_test wingestUser=dada_bridge erpUser=SFY can=B eje=26 alm=00001 serfac=1 claimLimit=20 leaseSeconds=300
2026-08-16T04:31:02.640Z INFO claimed claimToken=1f7c0f6e-6a2a-4f6b-9d3b-1a5b8e6d0c11 count=1
2026-08-16T04:31:04.902Z INFO injected orderId=9c1e0a52-3f42-4a6d-9b0f-1d2c3e4f5a6b orderNumber=1042 company="Wok Ciudad Lineal" codcli=1234 numped=8871 lineCount=7
2026-08-16T04:31:05.188Z INFO orders summary claimed=1 injected=1 recovered=0 markFailed=0 failed=0 ok=true
```

### 一轮健康的 orders（没订单——99% 的分钟长这样）

```
2026-08-16T04:32:02.061Z INFO start job=orders dir=C:\dada\bridge ...
2026-08-16T04:32:02.402Z INFO nothing to inject claimToken=2b8d1c33-...
2026-08-16T04:32:02.404Z INFO orders summary claimed=0 injected=0 recovered=0 markFailed=0 failed=0 ok=true
```

没订单时**不会**连 ERP——一分钟一次的任务不该为"没事干"开一条 SQL 连接。

### albaran-sync

```
2026-08-16T05:10:01.550Z INFO start job=albaran-sync dir=C:\dada\bridge ...
2026-08-16T05:10:02.771Z INFO albarán matched orderId=9c1e0a52-... numped=8871 numalb=4410
2026-08-16T05:10:02.980Z INFO albaran-sync summary injected=1 matched=1 marked=1 ok=true
```

没有在等出货单时只有一行 `nothing awaiting an albarán`。

### price-sync

```
2026-08-16T12:30:01.204Z INFO start job=price-sync dir=C:\dada\bridge ...
2026-08-16T12:30:03.815Z INFO read articulo articles=3021
2026-08-16T12:31:40.002Z INFO progress applied=500 of=3021
2026-08-16T12:38:22.117Z INFO merged matched=2854 notInPortal=167 withAnyPrice=2790 syncedAt=2026-08-16T12:30:03.900Z sample=1-0001,1-0002,1-0007,2-0114,...
2026-08-16T12:38:29.640Z INFO price-sync summary articles=3021 matched=2854 notInPortal=167 fullyUnpriced=42 orderableWithPrice=2712 notInPortalSample=["1-0001","1-0002","1-0007","2-0114"] ok=true
```

`notInPortal` 是 ERP 里有、门户里没有的编号数量；`sample=` / `notInPortalSample`
列出前 20 个，用来判断那批到底是"ERP 自用的包材/服务条目"还是"门户导入漏了一个
品类"。price-sync 跑几分钟是正常的（三千多个商品，一个一个 PATCH）。

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
GRANT SELECT ON dbo.stolot        TO dada_bridge;  -- FIFO 批次（未过期、VENDIBLE=1）
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

-- 6) 收回沙箱阶段图省事给的大权限
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
- [ ] **`BRIDGE_EJE` 核对**（默认 26 = 2026 会计年度）。跨年时要改。
- [ ] **第一张订单人工盯着走完**：门户下单 → 员工确认 → 等一分钟 → 看
      `bridge.log` 的 `injected` 行 → 在 Wingest 里打开这张 Pedido，确认
      `NUMPEDCLI` 是 `PORTAL-<订单号>`、价格与门户一致、行数和批次正常 → 人工
      转成 Albarán → 下一个整点后确认门户订单变成「已出单」并带 numalb。
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
| **失败** | 红 | 这一轮没跑完（`RUN_FAILED` 等），旁边显示错误码 | 去服务器看 `bridge.log` 的同一时刻 |
| **未运行（可能未调度）** | 琥珀 | 有心跳，但太旧了：orders 超过 10 分钟 / albaran-sync 超过 3 小时 / price-sync 超过 26 小时 | 任务被停用了？服务器关机了？先看计划任务 |
| **未运行** | 琥珀 | 从来没有过心跳 | 程序没装、任务没建，**或 `bridge.env` 配置失败** |
| **桥接未部署** | 琥珀 | 三个任务一条心跳都没有 | 整套还没上线，或装错了机器 |

**要看数字，不要只看颜色。** 每行下面是那一轮的计数：

- `orders`：`认领 / 已注入 / 已找回 / 回写失败 / 失败`。
  `回写失败`（markFailed）是最值得盯的一个：**pedido 已经写进 ERP 了，但门户没
  记上**。下一轮会重新认领、靠 `PORTAL-<订单号>` 去重找回同一个 NUMPED 再回写
  一次；连续几轮不归零就要人工看。
- `albaran-sync`：`已匹配 / 已回写`。正常情况下两个数相等；`已回写` 少于
  `已匹配` 说明有订单状态被人改过（比如已取消）。
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
锁文件可能是上一轮崩溃留下的。桥接自己会在 30 分钟后接管过期的锁；等不及就停掉
任务、删掉 `C:\dada\bridge\orders.lock`（日志里 `path=` 就是这个文件）、再启用。

**日志里 `mark_injected returned false — pedido exists, portal not updated`**
ERP 里单子写成功了，门户没记上（租约过期或订单被人改过）。下一轮会自动重试并
靠去重找回同一个 NUMPED，不会写出第二张 Pedido。连续多轮不消失才需要人工处理。

**日志里 `injected orders without a numped`**
门户里有订单是 `injected` 状态却没有 NUMPED——这是门户侧的异常，找我们看。

**手动跑得好好的，计划任务却失败**
九成是 `/tr` 的引号转义（见第 ③ 节）或者运行账号没有 `C:\dada\bridge\` 的写权限
（写不了 `bridge.log` 和锁文件）。`schtasks /query /v /fo list` 里的"上次结果"
配合 `bridge.log` 一起看。

**price-sync 跑到一半停了**
日志里会写到第几个商品（`position=1234/3021`）。合并是按编号幂等的，直接重跑
一次即可，不会重复计价。
