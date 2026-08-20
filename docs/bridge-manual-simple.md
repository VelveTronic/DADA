# DADA 桥接部署手册 · 简约版

> 给 DADA 非技术同事看的版本：每条命令都标了**在哪台电脑上做**，照抄即可。
> 想看原理、完整故障手册和沙盒测试流程，请看技术版：[bridge-runbook.md](bridge-runbook.md)（本文引用它的章节号，如「技术版 §⑤」）。

---

## 一、这是什么

**桥接（dada-bridge）= 门户和 Wingest 之间的自动搬运工**，一个单文件小程序，装在 SERVER 上，定时自动跑：

| 它做的事 | 多久一次 | 效果 |
| --- | --- | --- |
| 把门户里**已确认**的订单写进 Wingest（成为一张 Pedido，单号 `PORTAL-订单号`） | 每 1 分钟 | 员工不用再手工录单 |
| 检查哪些 Pedido 已被开成 Albarán，把送货单号写回门户 | 每小时 | 客户在门户看到「已出单」 |
| 把 Wingest 的价格、箱数、称重标志同步到门户商品目录 | 每天 06:30 | 门户价格永远跟 ERP 一致 |

它**只新增** Pedido、只把计数器 +1——**改不动、删不掉** ERP 里已有的任何东西。库存、批次、开单照旧由员工在 Wingest 里操作，习惯完全不变。

## 二、三台电脑，各管什么

| 电脑 | 标记 | 在上面做什么 |
| --- | --- | --- |
| 老板的开发电脑（`F:\DADA Distribucion\DADA`） | 【开发机】 | 生成程序文件，拷给 SERVER |
| ERP 服务器（RustDesk 远程过去） | 【SERVER】 | 桥接装在这里、跑在这里；SQL 授权也在这里 |
| 任意办公工位（如 OSCAR） | 【工位】 | 照常用 Wingest：看到 `PORTAL-` 开头的 Pedido，用**单据表单上的 Albarán 按钮**转单 |
| 任何浏览器 | 【浏览器】 | 门户员工后台：确认订单、看「桥接状态」卡片 |

---

## 三、一次性部署（按顺序，共 7 步）

### 第 1 步【开发机】生成并拷贝程序

```
cd "F:\DADA Distribucion\DADA"
pnpm bridge:build
```

把生成的 `F:\DADA Distribucion\DADA\bridge\dist\dada-bridge.js` 拷到 SERVER 的 `C:\dada\bridge\`。
（⚠️ 以后每次门户代码更新过桥接，都要重新做这一步——旧程序配新数据库会出错。）

### 第 2 步【SERVER】装 Node（装过就跳过）

官网下载 Node.js LTS（≥22）的 MSI，一路下一步。装完在 CMD 确认：

```
node --version
```

显示 `v22.x` 或更高即可。

### 第 3 步【SERVER】写配置文件

用记事本新建 `C:\dada\bridge\bridge.env`，内容照抄下面，只需把两个 `<从保险库取>` 换成真实密钥：

```ini
SUPABASE_URL=https://gudiykhngonoqsjoigza.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<从保险库取>

WINGEST_SERVER=SERVER,50352
WINGEST_DB=wgdemo
WINGEST_USER=dada_bridge
WINGEST_PASSWORD=<从保险库取>

# 盖在 Pedido 上的 ERP 操作员代号（老板定，必须是 Wingest 里真实存在的用户，最长 4 位）
BRIDGE_ERP_USER=SFY
BRIDGE_CAN=B
# 会计年度：2026 年填 26。每年 1 月 1 日前改成新年度！
BRIDGE_EJE=26
BRIDGE_ALLOW_HISTORICAL_EJE=false
BRIDGE_ALM=00001
BRIDGE_SERFAC=1
CLAIM_LIMIT=20
LEASE_SECONDS=300
```

三条铁律：**① 密钥不截图、不外传、不存副本；② `WINGEST_SERVER` 必须写 `SERVER,50352` 这种「逗号+端口」格式，绝不要写反斜杠实例名；③ `WINGEST_DB=wgdemo` 就是生产库**（想先在沙盒试，改成 `wg_test` 即可，程序连上后会自己核对库名，连错库会拒绝干活而不是写错地方）。

### 第 4 步【SERVER】给桥接的数据库账号"办工作证"

**这一步在做什么（一句话）**：数据库里有一个专给桥接用的账号，叫 `dada_bridge`。现在给它发一张权限刚刚好的"工作证"——只能**读**商品、客户、库存资料，只能**新增**订单，其他什么都碰不了、删不了。整个过程就是复制粘贴一段现成的文字，不需要懂数据库。

**4a. 打开数据库管理工具并连接**

在 SERVER 桌面或开始菜单找 **SQL Server Management Studio**（图标是一个黄色扳手+圆柱，简称 SSMS）打开。弹出的连接窗口里：

| 栏位 | 填什么 |
| --- | --- |
| Server name / 服务器名称 | `localhost,50352` |
| Authentication / 身份验证 | Windows Authentication（Windows 身份验证，不用输密码） |

点 **Connect / 连接**。（找不到 SSMS 这个程序？停下，喊技术支持远程做，这一步总共 5 分钟。）

**4b. 粘贴脚本并运行**

点左上角 **New Query / 新建查询**，出现一个空白编辑区。把下面整块**从第一行到最后一行完整复制**进去，然后按键盘 **F5**（或点工具栏的 Execute / 执行）：

```sql
USE wgdemo;
GO

-- 账号进入 wgdemo 库（已存在则跳过）
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'dada_bridge')
    CREATE USER dada_bridge FOR LOGIN dada_bridge;
GO

-- 只读：商品、客户、库存批次、税率、操作员、单据
GRANT SELECT ON dbo.clientes      TO dada_bridge;
GRANT SELECT ON dbo.articulo      TO dada_bridge;
GRANT SELECT ON dbo.stolot        TO dada_bridge;
GRANT SELECT ON dbo.tipivaar      TO dada_bridge;
GRANT SELECT ON dbo.iva           TO dada_bridge;
GRANT SELECT ON dbo.susuario      TO dada_bridge;
GRANT SELECT ON dbo.albfacca      TO dada_bridge;
GRANT SELECT ON dbo.albfacli      TO dada_bridge;
GRANT SELECT ON dbo.pedclicah     TO dada_bridge;

-- 读 + 新增：订单的三张表（改不了、删不了已有内容）
GRANT SELECT, INSERT ON dbo.pedclica     TO dada_bridge;
GRANT SELECT, INSERT ON dbo.pedclili     TO dada_bridge;
GRANT SELECT, INSERT ON dbo.pedclica_adi TO dada_bridge;

-- 读 + 更新：单号计数器（只会 +1）
GRANT SELECT, UPDATE ON dbo.newcontador  TO dada_bridge;
GO

-- 收回以前测试阶段图省事给的大权限（本来就没有的话自动跳过）
IF IS_ROLEMEMBER('db_owner', 'dada_bridge') = 1
    ALTER ROLE db_owner DROP MEMBER dada_bridge;
GO

-- 核对：打印这张"工作证"上的全部权限
SELECT o.name AS objeto, p.permission_name AS permiso
FROM sys.database_permissions p
JOIN sys.objects o ON o.object_id = p.major_id
WHERE USER_NAME(p.grantee_principal_id) = 'dada_bridge'
ORDER BY o.name, p.permission_name;
```

**4c. 看结果，两个判据**

- 运行后下方出现一张小表格，**恰好 17 行**——每行是一条权限，最右列只会出现 `SELECT` / `INSERT` / `UPDATE` 三种字样。是 17 行就算通过，截个图发给技术支持存档。
- 如果出现**红色错误文字**：什么都不要改、不要重试，把整个窗口截图发给技术支持。这个脚本只发权限，不动任何数据，跑一半也不会弄坏东西。

### 第 5 步【SERVER】手动跑一轮验证

CMD 里逐条执行（此时门户里最好有一笔「已确认」的测试订单）：

```
node C:\dada\bridge\dada-bridge.js --help
node C:\dada\bridge\dada-bridge.js orders
node C:\dada\bridge\dada-bridge.js price-sync
```

- `orders` 期待看到 `injected …` 和结尾 `ok=true`（门户没有已确认订单时显示 `nothing to inject`，也算正常）。
- 报错不用慌：错误信息会直接说明是哪一项配置不对（比如密码错、缺哪张表权限）。日志在 `C:\dada\bridge\bridge.log`，**密钥自动打码，整段复制发给技术支持是安全的**。

### 第 6 步【SERVER】建三个定时任务

以**管理员身份**打开 CMD，把 `SERVER\<账号>` 换成实际运行账号（普通本地账号即可，不要用管理员），逐条执行，提示时输入该账号密码：

```
schtasks /create /tn "DADA Bridge Orders" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" orders" /sc minute /mo 1 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

```
schtasks /create /tn "DADA Bridge Albaran" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" albaran-sync" /sc hourly /mo 1 /st 00:10 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

```
schtasks /create /tn "DADA Bridge Prices" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\dada\bridge\dada-bridge.js\" price-sync" /sc daily /mo 1 /st 06:30 /ru "SERVER\<账号>" /rp * /rl LIMITED /f
```

> SERVER 的时钟自 2026-08-18 起就是马德里时间，`06:30` 直接就是马德里早上六点半，无需换算。
> 建完后建议按技术版 §② 给 `bridge.env` 加一层文件权限（icacls 三条命令），防止其他登录者看到密钥。

### 第 7 步【浏览器】+【工位】盯着第一张真订单走完全程

1. 【浏览器】客户（或测试账号）在门户下单 → 员工后台点「确认」；
2. 等 1 分钟，【浏览器】员工后台首页「桥接状态」卡片 → **订单注入**一行变绿；
3. 【工位】Wingest 里找到这张 Pedido（客户订单号一栏是 `PORTAL-xxxx`），核对客户、行数、**行金额**（门户每箱价×箱数 = ERP 的 SUBTOT，必须一分不差）；
4. 【工位】照常用**表单上的 Albarán 按钮**转单（不要用批量转换入口）；
5. 下一个整点后，【浏览器】门户里这张订单变「已出单」，带 ERP 单号和送货单号。

五步全对 = 部署完成。✅

---

## 四、上线前的业务检查单（一次性）

- [ ] **每家餐厅的门户账号都链接了正确的 Wingest 客户号（codcli）**——员工后台「用户管理」里核对。测试账号 cliente-test 目前链到 codcli=3（沙盒用），割接前改掉或停用。
- [ ] **`BRIDGE_ERP_USER` 由老板定**：这个代号会盖在每张自动 Pedido 上，客户和业务都看得到。
- [ ] **清理陈年未关闭的 Pedido**（状态 Abierto 的旧单）：它们会占用批次可用量，导致转单时报「库存不足」。让技术支持列一份清单再关。
- [ ] **五个箱数系数可疑的商品**（2-006 / 9-018 / 9-087 / 9-097 / 9-100）目前在门户是停售状态：在 Wingest 里改好 UNILOT → 等一次价格同步 → 门户商品管理里重新上架。

## 五、日常怎么看它活着（员工后台首页「桥接状态」卡片）

| 颜色 | 意思 | 要做什么 |
| --- | --- | --- |
| 🟢 正常 | 一切正常 | 什么都不用做 |
| 🟣 上一轮还在跑 | 忙，不是坏 | 不用管，一分钟后自己好 |
| 🟡 有订单等待重试 | 有一张单没进去，程序自己在重试 | 观察；反复出现再找技术支持 |
| 🔴 有订单需人工处理 / 失败 | 需要人管了 | 员工订单页看「注入失败」的错误说明；把 `bridge.log` 整段发给技术支持 |
| 🟠 未运行 | 任务没跑（停了？服务器关了？） | 查 SERVER 开着没有、任务计划程序里三个任务是否启用 |

## 六、出大事怎么办：一键停

【SERVER】管理员 CMD，三条命令立即停掉全部自动化：

```
schtasks /change /tn "DADA Bridge Orders" /disable
schtasks /change /tn "DADA Bridge Albaran" /disable
schtasks /change /tn "DADA Bridge Prices" /disable
```

停掉后**什么都不会坏**：门户照常接单（订单停在「已确认」排队），ERP 里已写入的单一张不丢、不重复。问题查清后把 `/disable` 换成 `/enable` 逐条恢复，积压订单会自动按顺序补进 ERP，无需人工补录。

## 附录、Wingest 全店连不上 SQL（Error 08001）应急三板斧

> 2026-08-20 真实事故的教训。症状：所有工位（甚至 SERVER 本机）开 Wingest 都弹
> `No hemos podido conectar con el servidor SQL - Error 08001`。

1. **刚重启过 SERVER？先等 2 分钟再试。** 这台服务器配置低，SQL 开机预热要一两分钟，期间报 08001 是正常的。
2. **弹出「Conexion Servidor」对话框时，永远点 Cancelar，绝不点 Aceptar。** 点 Aceptar 会把框里的内容（往往是乱码）写回全店共用的配置文件 `C:\WINGEST8\conex.sql`，把小故障变成大故障。唯一例外：技术人员指导下有意重建配置时——填 `192.168.1.40\WINGEST` + 用户 `sa` + 密码后点 Aceptar。
3. **两个常见根源**（都在 SERVER 上）：
   - **防火墙被系统更新悄悄重新启用**：检查放行规则「SQL Server 50352 (Wingest LAN)」和「SQL Browser 1434 (Wingest LAN)」是否还在、是否启用（Windows 安全中心 → 防火墙 → 高级设置 → 入站规则）。
   - **配置文件被写坏**：`C:\WINGEST8\conex.sql` 的修改日期如果是"刚刚"，说明被人点 Aceptar 写坏了——用备份还原：把 `C:\Users\Admin\Desktop\WINGEST8\conex.sql.bueno-20260820` 复制为 `C:\WINGEST8\conex.sql`，再开 Wingest。

另有一颗定时炸弹待拆：SERVER 的 IP `192.168.1.40` 目前是路由器自动分配的（配置文件里写死了这个 IP），路由器哪天换了分配，全店就会重演 08001。**根治：在路由器 DHCP 设置里把 MAC `50-EB-F6-24-27-64` 永久保留为 `192.168.1.40`。**

## 七、红线（不要做的事）

1. **不要**改 `bridge.env` 里的 `SUPABASE_URL`——程序只认这一个地址，改了直接罢工（防呆设计）。
2. **不要**用 Wingest 的「批量创建 Albarán」转 `PORTAL-` 单（会无声失败），只用单据表单上的 Albarán 按钮。
3. **不要**看到门户单没进 ERP 就手工照抄录一张——程序会自动重试并去重；手工单反而制造重复。先看状态卡，再看日志。
4. **不要**复制、截图、外传 `bridge.env`。
5. 每年 **1 月 1 日前**记得把 `BRIDGE_EJE` 改成新年度（技术版 §⑥），否则新年第一张订单会被安全拦下（报 `EJE_YEAR_MISMATCH`，不丢单，改完即恢复）。
