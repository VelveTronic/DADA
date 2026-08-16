-- =====================================================================
-- verify-sandbox-pedido.sql
-- 沙盒验收查询 / Verificación del pedido inyectado en el sandbox
-- ---------------------------------------------------------------------
-- 库 / Base de datos:  wg_test（沙盒。生产库 wgdemo 不要跑，也不需要跑）
-- 性质 / Naturaleza:   **只读**。全文只有 SELECT，一行都不写。
--
-- 跑法一（SSMS）：连 SERVER,50352 → 选 wg_test → 打开本文件 → 执行。
-- 跑法二（sqlcmd，密码不进命令历史）：
--   sqlcmd -S SERVER,50352 -d wg_test -U dada_bridge -W -s " | " -i verify-sandbox-pedido.sql
--   （不带 -P，回车后 sqlcmd 会提示输入密码）
--
-- 对应手册：docs/bridge-runbook.md 第 ⑨ 节「沙盒测试」步骤 5。
-- 前提：`CAN='B'` 和 `EJE=26` 就是 bridge.env 里 BRIDGE_CAN / BRIDGE_EJE 的
--       默认值；改过那两项的话，这里也要跟着改。
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0) 连对库了吗？顺便看一眼服务器时钟和马德里当天
--    （SERVER 的钟是中国时间；注入器写的业务日期取的是 HOY_MADRID 这一列）
-- ---------------------------------------------------------------------
SELECT
    DB_NAME()                                                              AS BASE_DE_DATOS,
    @@SERVERNAME                                                           AS SERVIDOR,
    SYSDATETIME()                                                          AS AHORA_SERVIDOR,
    CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Romance Standard Time' AS date)  AS HOY_MADRID;
GO


-- ---------------------------------------------------------------------
-- 1) 最近 5 张 PORTAL-* 抬头（新的在最前）
--    pedclica  = 活动表：刚注入、还没转 Albarán 的单在这里
--    pedclicah = 历史表：**转成 Albarán 之后 pedido 会从活动表消失、归档到这里
--                （ESTPED='Servido Total'）**——查不到反而是转换成功的特征。
--                去重/找回（recovery）也是查这两张表的并集。
--    看什么：NUMPEDCLI = PORTAL-<门户订单号>；FECPED/FECENT 是马德里当天且
--            时分秒为 00:00:00；刚注入时 ESTPED='Abierto'、ALBARAN=0。
-- ---------------------------------------------------------------------
WITH cab AS (
    SELECT CAST('pedclica' AS varchar(10)) AS ORIGEN,
           CAN, EJE, NUMPED, NUMPEDCLI, CODCLI, FECPED, FECENT,
           ESTPED, ALBARAN, NETO, TOTPED
    FROM dbo.pedclica
    WHERE CAN = 'B' AND NUMPEDCLI LIKE 'PORTAL-%'
    UNION ALL
    SELECT CAST('pedclicah' AS varchar(10)) AS ORIGEN,
           CAN, EJE, NUMPED, NUMPEDCLI, CODCLI, FECPED, FECENT,
           ESTPED, ALBARAN, NETO, TOTPED
    FROM dbo.pedclicah
    WHERE CAN = 'B' AND NUMPEDCLI LIKE 'PORTAL-%'
)
SELECT TOP 5
    c.ORIGEN,
    RTRIM(c.CAN)        AS CAN,
    c.EJE,
    c.NUMPED,
    RTRIM(c.NUMPEDCLI)  AS NUMPEDCLI,
    c.CODCLI,
    c.FECPED,
    c.FECENT,
    RTRIM(c.ESTPED)     AS ESTPED,
    c.ALBARAN,
    c.NETO,
    c.TOTPED
FROM cab AS c
ORDER BY c.EJE DESC, c.NUMPED DESC;
GO


-- ---------------------------------------------------------------------
-- 2) 上面那 5 张单的明细行
--    pedclili  = 活动表的行；pedclilih = 转 Albarán 时一起归档的历史行。
--    看什么：CODART 与门户一致、**CANSER = CANPED 且 > 0**（这是能转成
--            Albarán 的前提）、PREVEN/SUBTOT 等于门户确认时的价格、
--            CODLOT 是 FIFO 挑出来的批次（无批次商品为空是正常的）。
--    ⚠️ 万一某张历史表的列名对不上，SQL Server 会报 "Invalid column name"：
--       把对应的那半段 UNION ALL 注释掉即可——步骤 5 是在转单**之前**跑的，
--       活动表那一半就够看。
-- ---------------------------------------------------------------------
WITH cab AS (
    SELECT CAST('pedclica' AS varchar(10)) AS ORIGEN, CAN, EJE, NUMPED, NUMPEDCLI
    FROM dbo.pedclica
    WHERE CAN = 'B' AND NUMPEDCLI LIKE 'PORTAL-%'
    UNION ALL
    SELECT CAST('pedclicah' AS varchar(10)) AS ORIGEN, CAN, EJE, NUMPED, NUMPEDCLI
    FROM dbo.pedclicah
    WHERE CAN = 'B' AND NUMPEDCLI LIKE 'PORTAL-%'
),
top5 AS (
    SELECT TOP 5 ORIGEN, CAN, EJE, NUMPED, NUMPEDCLI
    FROM cab
    ORDER BY EJE DESC, NUMPED DESC
),
lin AS (
    SELECT CAST('pedclili' AS varchar(10)) AS ORIGEN_LIN,
           CAN, EJE, NUMPED, NUMLIN, CODART, DESMOD, CANPED, CANSER,
           PREVEN, SUBTOT, CODALM, CODLOT, FECCAD, unidad, UNILOT, CAJ
    FROM dbo.pedclili
    UNION ALL
    SELECT CAST('pedclilih' AS varchar(10)) AS ORIGEN_LIN,
           CAN, EJE, NUMPED, NUMLIN, CODART, DESMOD, CANPED, CANSER,
           PREVEN, SUBTOT, CODALM, CODLOT, FECCAD, unidad, UNILOT, CAJ
    FROM dbo.pedclilih
)
SELECT
    RTRIM(t.NUMPEDCLI)  AS NUMPEDCLI,
    t.NUMPED,
    l.ORIGEN_LIN,
    l.NUMLIN,
    RTRIM(l.CODART)     AS CODART,
    RTRIM(l.DESMOD)     AS DESMOD,
    l.CANPED,
    l.CANSER,
    l.PREVEN,
    l.SUBTOT,
    RTRIM(l.CODALM)     AS CODALM,
    RTRIM(l.CODLOT)     AS CODLOT,
    l.FECCAD,
    RTRIM(l.unidad)     AS UNIDAD,
    l.UNILOT,
    l.CAJ
FROM top5 AS t
JOIN lin AS l
  ON l.CAN = t.CAN AND l.EJE = t.EJE AND l.NUMPED = t.NUMPED
ORDER BY t.EJE DESC, t.NUMPED DESC, l.NUMLIN;
GO


-- ---------------------------------------------------------------------
-- 3) 单号计数器（参考值）
--    NUMERO 是**下一张**要发出去的 NUMPED：注入时取旧值用、同一句里 +1。
--    所以正常情况下 NUMERO = 上面第 1 段里最大的 NUMPED + 1。
-- ---------------------------------------------------------------------
SELECT
    RTRIM(CAN)       AS CAN,
    EJE,
    RTRIM(ELEMENTO)  AS ELEMENTO,
    NUMERO           AS PROXIMO_NUMPED
FROM dbo.newcontador
WHERE CAN = 'B' AND EJE = 26 AND ELEMENTO = 'NUMPEDCLI';
GO
