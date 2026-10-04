# 离心转子配平（Rotor Balance）

实验室离心转子装载配平 Web 应用：录入转子参数、本次离心管称重数据与可选配重块，
系统按约束求**可行装载图**，优化目标依次为：

1. **配重块使用数量最少**；
2. **各对对径孔质量差之和最小**；
3. 目标完全相同时，按**孔位编号对应的物件编号序列字典序取小**
   （次序约定：离心管编号 → 配重块 `质量组#组内序号` → 空孔；即小编号离心管优先占据低编号孔位）。

无解时明确列出原因。发布时在**单个数据库事务**内重读当前数据与避邻规则、重新求解并用独立校验器复核，
通过后冻结装载图及其数据依据（哈希）。此后录入数据或避邻规则的任何修改**不会改动旧图**，
但旧图会被标记为「**不可用于当前装载**」。

实验室部分离心管不能占据相邻孔位：操作者按管编号维护**避邻对**（环形孔位中孔 `i` 与孔
`(i+1)%N` 相邻，同对两管不得相邻）。未知编号、自配对、重复配对（含颠倒）整次拒绝；
替换离心管若会留下失效避邻对，同样拒绝并保留原数据。草稿在原有装载约束与优化顺序下
寻找满足避邻规则的最优图，无解时说明冲突（区分「约束本身无解」与「规则冲突」）。
发布时在事务内重读规则并独立复核，规则随装载图一并冻结；**未配置规则时**，
录入、发布、预约、核验流程与无规则一致，旧发布图仍按原规则判定可用。

实验人员**预先摆好部分离心管**时，可按已录入管编号与孔位维护**固定孔位**（整组保存、
修改或清空）：未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定**整组拒绝**，
原绑定保留；修改管的可用孔位或转子孔数若使绑定失效，同样整次拒绝。草稿必须将指定管
放在固定孔位，并同时满足承重、对径差与避邻规则；在可行图中仍按「配重数最少 → 对径差和
最小 → 孔位物件编号序列字典序最小」选图。约束冲突时说明无解（区分「约束本身无解」与
「固定孔位/避邻规则冲突」），不得发布。发布时在事务内重读固定孔位并独立复核，绑定随图
冻结；绑定变化使旧图不可用于当前装载（历史不改写），**清空后无固定孔位的行为与现状
完全一致**（数据指纹与无绑定历史数据相同）。

现场可对**仍可用于当前装载**的发布记录做**装载核验**：按孔位录入实际物件编号与实测质量
（有物件为有限正数，空孔留空、质量 0），可暂存/恢复，携带版本号防止并发覆盖；
完成时在**单个数据库事务**内重读发布快照与当前数据，逐孔核对物件与承重、逐对核对径差
以及发布记录的当前可用性，通过后冻结实测值、判定明细与发布编号。

实验室在不同时段复用配重块：操作者凭**批次号 + 当前可用的已发布装载图 + UTC 起止时间**
预约配重块（起点须早于终点，非法时间或未知图一律拒绝）。时段按**左闭右开** `[start, end)`
计算，占用量按**冻结图**统计到各质量规格；创建预约在**单个数据库事务**内原子重读冻结图、
当前库存、重叠的生效中预约**与重叠的生效停用**——任一时刻同规格「预约占用 + 临时停用」
总量不得超过当前录入数量，不足时返回**冲突规格与时段**且**不产生任何部分占用**。批次号为幂等键：
同号同内容重复提交返回原记录，同号不同内容拒绝；**仅未开始的预约可取消**，取消后保留历史
且同号重试不重新占用。录入数量减少或图失效**不改写既有预约**，后续预约仍按当前数量与图可用性
判定，预约日程中展示已有占用、停用量及「占用」「占用 + 停用」两类不足区段。

配重块需要**临时停用**（送检、损坏等）时按**质量规格**登记停用数量、原因与 UTC 起止时间
（左闭右开）；同规格重叠时段的停用量**累加**，任一时刻停用量不得超过**登记时**该规格的
当前数量，超量/非法时间/非法数量/未知规格一律拒绝且**不留记录**。停用登记后立即影响
**新预约**的可用量（既有预约不改写，停用允许与既有预约重叠）；**仅未开始的停用可撤销**，
撤销保留历史并立即释放后续容量。

实验人员执行**离心运行**时，以**唯一运行编号、非空设备编号、已完成核验编号和预约编号**
开始一次运行；**开始与结束时间由服务端记录**。开始在**单个事务**内依次确认：

1. 核验存在且**已完成**（核验结论已冻结，未完成草稿不能开始）；
2. 核验与**生效预约**指向**同一张发布图**；
3. 该发布图**当前可用**（数据指纹与当前录入一致、图可行）；
4. **当前时刻处于预约左闭右开时段** `[start, end)`；
5. 该预约**未用于其他运行**（一个预约至多开始一次运行）；
6. **同设备无进行中运行**。

任一条件不满足即指出冲突并整体回滚、**不留记录**。开始成功后**冻结发布图**（编号、数据指纹
与完整快照）、**核验结论**（通过、实测对径差和、逐孔/逐对判定）与**预约时段**（起止与冻结
占用规格）。完结时如实填写 **完成 / 中止**；结束时间由服务端记录且**必须晚于开始时间**；
即使**超过预约终点**也如实完结并标记 **超时（`timedOut`）**，完结随即**释放设备**，
**不改写预约**（预约取消与否、配置/库存/预约状态的后续变化都不改写历史运行）。
相同运行编号以**相同开始内容**重复提交返回原记录（200），**异内容拒绝**（409）；
完结以**相同状态**重复提交返回原结果（200），**异状态拒绝**（409）。

实验室按**设备累计运行时长**安排保养：可按设备编号设置**正整数秒数上限**，随时查看
**自最近一次保养后已完结运行的累计时长、剩余额度与待保养状态**（尚无保养记录时计入
该设备全部已完结运行；完成与中止均按服务端起止时间计入，进行中的运行不提前计入）。
运行即使**越过上限也如实完结并释放设备**；后续开始运行须在**原事务内核对额度**，
**达到上限即拒绝且不留新运行**，未设置上限的设备沿用原行为。设备空闲时可凭
**唯一保养单号 + 设备编号 + 原因**登记保养，登记时刻（服务端记录）开启新累计周期；
**同号同内容重试返回原记录**（200），**异内容或设备运行中拒绝**（409）。
**调整上限仅影响后续开始判定**，不改写运行及保养历史；原运行接口的输入、状态码、
幂等重放与冻结依据保持兼容，**既有运行编号重试不受额度变化影响**。

实验室按**设备校准记录**决定运行能否放行。登记校准记录时填写**唯一校准单号、设备编号、
校准时间、到期时间和合格/不合格结论**（时间均为 UTC）：校准时间须**早于**到期时间且
**不得晚于服务端当前时刻**，同一设备的校准时间须**晚于上一条**记录。校准记录**只追加**，
按设备**最新一条**判定。**已有校准记录的设备**开始运行时，须在**原事务内**确认：
最新一条结论**合格**，且其到期时间**不早于本次预约终点**（到期恰等于终点视为足够）；
**无校准记录的设备沿用现有开始规则**。不合格或有效期不足时 409 拒绝，响应说明原因
（`detail.reason` 为 `failed` / `expired`），且**不留运行**。开始成功后**冻结校准依据**
（校准单号、结论、校准/到期时间）；之后新增校准记录、运行超时或完结均**不改写历史**。
校准单号为幂等键：**同号同内容**重复提交返回原记录（200），**同号异内容拒绝**（409）；
无效输入（含校准时间晚于当前时刻、校准不早于到期）返回 400 且**不留校准记录**；
同设备校准时间不晚于上一条返回 409。原运行开始输入及同号重放约定保持兼容
（同号同内容重放不重新核对校准，仍返回原冻结记录）。

现场按**实物编号**追踪配重块领还：按现有质量规格登记**唯一实物编号**（同规格
**有效实物数**——已登记未注销，含领出与损坏——**不得超过当前库存**；**已领出实物
不能注销**；库存缩减若低于有效实物数则**整次拒绝**并保留原数据）。凭**生效预约**在其
**左闭右开时段**内领用：所选实物按规格**精确匹配预约冻结占用量**，且均未被其他未归还
领用占用；**同一预约只可领用一次**——同内容重试返回原单（200），异内容拒绝（409）。
归还时**逐件标记完好或损坏**：**非本单实物及重复归还整次拒绝**（不留部分记录），
**损坏件不得再次领用**；**预约结束后仍可归还**，查询展示**未还件与逾期状态**
（当前时刻超过冻结预约终点且仍有未还件）。预约取消、库存调整及运行状态变化均
**不改写领还历史**（领用单冻结预约时段与占用量快照，实物编号与规格随单冻结）；
领还冲突整体回滚，**不留部分记录**。

## 约束模型

- 孔位编号 `0 … N-1`，孔位数 N 为 4–12 的偶数；孔 `i` 与孔 `i + N/2` 对径，孔 `i` 与孔 `(i+1)%N` 环形相邻。
- 避邻对：同对两管不得占据环形相邻孔位；未知编号、自配对、重复配对（含颠倒）整次拒绝。
- 固定孔位：指定离心管必须占据指定孔位（固定管不得出现在其他孔位，固定孔位不得放置
  其他物件）；未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定整组拒绝；
  修改管的可用孔位或转子孔数使绑定失效时整次拒绝。
- 每孔**最多一件**物件（一支离心管或一枚配重块），空孔质量按 0 计。
- 全部离心管**必须装入**；每枚配重块**最多使用一次**。
- 任一孔内物件质量不得超过该孔最大承重；离心管只能放入其声明的可用孔位。
- 每对对径孔的质量差不得超过允许对径差（容差）。
- 非法质量（非数、≤0 等）、重复编号、孔位越界一律拒绝，**不留下任何部分数据**
  （整表替换在一个 SQLite 事务中完成，校验失败即回滚）。

求解算法：按对径孔对逐对做动态规划（状态 = 已用离心管位图 + 各配重组已用数量 + 相邻约束所需的
上一对/首对物件身份），同状态只保留目标三元组最优的路径（Pareto 保优），规模上界 N=12。

## 一键启动（Docker Compose）

前置要求：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

首次启动会自动：

1. 安装全部依赖（容器内编译 better-sqlite3 原生模块）；
2. 初始化 SQLite 数据库与全部表结构（服务启动时自动建表，无需手工脚本）。

访问地址：

- **http://localhost:8080** （浏览器界面）

停止 / 查看日志：

```bash
docker compose down        # 停止（数据卷保留）
docker compose logs -f     # 查看日志
```

数据持久化在命名卷 `rotor-data`（容器内 `/app/data/rotor.db`）。
如需彻底清空：`docker compose down -v`。

## 本地直接运行（不使用 Docker）

需要 Node.js ≥ 20；better-sqlite3 为原生模块，首次安装需要 Python 3 / make / g++。

```bash
npm install
npm start
```

运行测试：

```bash
npm test
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内）；Compose 中可用同名变量改主机映射端口，如 `PORT=9090 docker compose up -d` |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/rotor.db`（本地）/ `/app/data/rotor.db`（容器） | SQLite 数据库文件路径，目录不存在会自动创建 |

## 使用流程

1. **转子配置**：选择孔位数（4–12 偶数）、允许对径差（g）、各孔最大承重，保存。
2. **离心管**：逐行录入编号、称重质量、可用孔位（勾选），保存后自动配平。
3. **避邻对**：按管编号维护「不能相邻」的离心管对（下拉选择已录入编号），保存后自动配平。
   未知编号、自配对、重复配对（含颠倒）整次拒绝；删除离心管前须先解除涉及它的避邻对。
   不需要避邻约束时保持为空即可——流程与无规则完全一致。
4. **固定孔位**：实验人员预先摆好部分离心管时，按「管编号 + 孔位」登记绑定
   （下拉选择已录入编号与孔位），整组保存/修改/清空，保存后自动配平。
   未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定整组拒绝；
   删除离心管、收窄其可用孔位或缩小转子孔数使绑定失效时，该次修改整次拒绝。
   不需要固定孔位时保持为空即可——流程与无绑定完全一致。
5. **配重块**：按“质量 + 数量”录入每种可选配重规格（同质量自动归为一组），保存后自动配平。
6. **装载图草稿**：保存任一类数据后自动重算；称重或配重数据变化后，旧草稿显示
   「基于旧数据」警示且**禁止直接发布**，须点「按当前数据重算」。
7. **发布**：点「发布并冻结」。服务端在事务内重新读取当前数据与避邻规则、固定孔位 →
   重新求解 → 独立复核（承重、容差、管全装入、配重不超量、孔位可用、质量一致、避邻规则、
   固定孔位）→ 写入冻结记录。无解时拒绝发布并给出原因（含规则冲突说明）。
8. **已发布装载图**：列表中每条记录带状态徽标：
   - ✓ 可用于当前装载：记录的数据指纹（含避邻规则与固定孔位）与当前录入完全一致；
   - ✗ 不可用于当前装载：录入数据、避邻规则或固定孔位已变化；旧图内容保持冻结不变，
     可点开查看其当时的数据快照（含冻结的避邻对与固定孔位）。
   仅「✓ 可用于当前装载」的可行发布记录可点「现场核验此图」发起核验。
9. **现场装载核验**：
   1. 点「现场核验此图」建立核验草稿（空孔初始化，同一发布记录只保留一份草稿；
      已完成核验的发布记录不能再建）。
   2. 在弹窗中按孔位录入**实际物件编号**与**实测质量**（有物件必须是有限正数；
      空孔保持为空、质量为 0）。页面实时显示「已录入 / 应录入孔数」进度。
   3. 可随时「暂存录入」后中断，稍后从核验列表恢复；每次暂存版本号 +1，
      提交过期版本会被 409 拒绝，避免覆盖他人的修改。
   4. 「完成核验」在服务端**同一事务**内重读冻结发布快照与当前录入数据，判定：
      - 各孔实际物件编号与冻结图完全一致（不一致定位到**孔位**）；
      - 实测质量不超过该孔最大承重（超重定位到**孔位**）；
      - 各对径孔实测质量差不超过**冻结容差**（超限定位到**孔对**）；
      - 发布记录仍可用于当前装载（数据指纹一致）。
      
      任一不通过：弹窗列出原因并在表中高亮对应孔位/孔对，**草稿保留、不生成完成记录**。
   5. 核验通过后**冻结**实测值、逐孔/逐对判定明细与发布编号；重复完成幂等返回同一份结果，
      不再产生第二份；此后再修改录入会被拒绝，已完成核验不被改写。
10. **配重块时段预约**（第 9 节）：
   1. 选择「✓ 可用于当前装载」的发布图，填写批次号与 UTC 起止时间（页面输入按 UTC 解释），
      提交预约。占用量按冻结图统计（如 `50 g × 1`）。
   2. 时段按左闭右开计算：前一条的终点与后一条的起点相接时互不冲突。
   3. 数量不足时页面列出冲突规格与时段（既有占用、本次需求、当前可选数量），
      本次预约不产生任何占用。
   4. 同批次号同内容重复提交返回原记录（已取消的亦返回原取消记录，不重新占用）；
      同号不同内容被拒绝。
   5. 仅未开始的预约可「取消预约」；取消后历史保留、占用释放。
   6. 「占用日程」按当前录入数量展示各规格的分段占用与停用；数量减少或图失效后，
      既有预约保持不变，超出当前数量的区段按两种口径标记「不足」：
      - 预约占用本身超过当前库存（`shortage`，字段含义与往期一致）；
      - 预约占用加临时停用超过当前库存（`combinedShortage`）。
   7. **排班到设备**（HTTP API，见「预约设备排班 HTTP API 调用示例」）：预约生效后可把它
      安排到具体离心设备，提交预约编号与非空设备编号即可，时段沿用预约冻结窗口。
      同设备生效排班不能重叠（首尾相接允许），可按设备和时段查询占用（分段）与冲突；
      同预约同设备重复提交返回原记录，换设备即改派（仅未开始且未用于运行，原子切换，
      冲突保留原排班）；未开始且未运行的排班可取消，预约取消时排班同步取消。
      开始运行时若预约已排班，提交的设备必须与排班一致。
11. **配重块临时停用**（第 10 节）：
   1. 选择当前录入的质量规格，填写停用数量（正整数）、原因与 UTC 起止时间后提交。
      时段同样按左闭右开计算；同规格重叠停用量累加，任一时刻不得超过登记时该规格库存。
   2. 非法时间、非法数量、未知规格或超量停用一律拒绝，**不留下任何记录**；
      超量时 409 响应给出冲突规格与时段（`detail.conflicts[].windows`）。
   3. 停用登记后立即影响**新预约**：创建预约的同一事务内同时核对当前库存、重叠的生效
      停用与已有预约，任一时刻「占用 + 停用」超出库存则整单拒绝。
   4. 停用允许与既有预约重叠，**既有预约不改写**；占用日程同时展示停用量与
      「占用 + 停用」合计不足区段（仅「占用超库存」的旧字段含义保持不变）。
   5. 仅**未开始**的停用可「撤销停用」；撤销后历史保留（状态 `revoked`），
      后续容量立即释放；已撤销重复调用幂等返回原记录，已开始/已结束的停用返回 409。
12. **离心运行**（第 11 节页面）：
    1. 填写唯一运行编号、非空设备编号，选择**已完成核验**与一条**生效中预约**
       （下拉分别只列出已完成核验与生效预约），点「开始离心运行」。
    2. 服务端在单事务内确认核验已通过、核验与预约同指一张发布图、发布图当前可用、
       当前时刻处于预约左闭右开时段、预约未被其他运行使用、
       **预约有生效排班时提交的设备与排班设备一致（无排班不限制设备来源）**、
       同设备无进行中运行、
       保养额度未达上限；**已有校准记录的设备还须最新校准合格且到期不早于预约终点**
       （无校准记录的设备沿用原规则）；
       任一冲突即拒绝并明确指出冲突原因，**不留任何记录**。
    3. 开始成功后运行进入「进行中」，页面可查看开始时间（服务端记录）与冻结依据；
       运行期间发布图失效会在列表标记「依据图已失效（历史冻结不变）」，不影响进行中运行。
    4. 点「完成」或「中止」完结：结束时间由服务端记录（须晚于开始）；超过预约终点完结
       会显示「⏱ 超时完结」徽标；完结后设备立即可用于下一次运行，预约不被改写。
    5. 相同运行编号同内容重复提交返回原记录，异内容 409；完结同状态重放返回原结果，
       异状态 409。配置、库存或预约状态随后变化均不改写已冻结的运行历史。
    6. 点「查看冻结依据」可查看冻结发布图（含完整装载图与配置快照）、冻结核验结论
       （逐对径孔判定）、冻结预约时段与**冻结校准依据**（开始时该设备最新校准记录；
       无记录时显示「开始时无校准记录」）。
13. **设备保养**（第 13 节页面）：
    1. 在「设置 / 调整保养上限」中按设备编号填写正整数秒数上限并保存；
       「清除该设备上限」可恢复为不核对额度的原行为。调整仅影响后续开始判定，
       不改写运行及保养历史。
    2. 「设备状态」表实时呈现每台设备的当前状态（空闲 / 运行中）、**最新校准结论与
       到期时间**、保养上限、
       本周期已用时长（已完结运行次数）、剩余额度、待保养标记与最近保养时间；
       达到上限的设备整行高亮为「⚠ 待保养」，其后续新运行将被 409 拒绝。
    3. 设备空闲时在「登记保养」中填写唯一保养单号、设备编号与原因，提交后开启
       新累计周期（已用时长归零重计）；同号同内容重试返回原记录，
       异内容或设备运行中会被拒绝并在页面列出原因。
    4. 「保养记录」表列出全部保养单（单号、设备、原因、登记时间）。
14. **设备校准**（第 12 节页面）：
    1. 在「登记校准记录」中填写唯一校准单号、设备编号、校准时间与到期时间（页面输入
       按 UTC 解释），选择「合格 / 不合格」后提交。校准时间须早于到期时间、不晚于
       服务端当前时刻，同设备校准时间须晚于上一条；任一不满足都被拒绝且不留记录。
    2. 同校准单号同内容重放返回原记录；同号异内容（设备、时间或结论不同）返回 409。
    3. 「校准记录」表按校准时间倒序列出全部记录（只追加），并标注
       「✓ 合格（有效期内）/ ✗ 不合格 / ⏱ 合格但已到期」。
    4. 设备开始运行时按其最新一条校准记录在原事务内放行：结论合格且到期时间不早于
       本次预约终点方可开始；不合格或有效期不足会在开始时提示原因（不留运行）。
       无校准记录的设备不受此限制。开始后冻结校准依据，之后新增记录不改写历史。
15. **配重块实物领还**（HTTP API）：
    1. 按现有质量规格登记唯一实物编号（`POST /api/items`）：同规格有效实物数
       不得超过当前库存；实物编号为幂等键（同号同内容返回原记录，异内容拒绝）。
    2. 凭生效预约在其左闭右开时段内领用（`POST /api/checkouts`）：所选实物编号
       按规格精确匹配预约冻结占用量，且均在库可领（未被其他未归还领用占用、
       未损坏、未注销）；同一预约只可领用一次，同内容重试返回原单、异内容拒绝。
    3. 归还（`POST /api/checkouts/:id/returns`）逐件标记 `intact`（完好）/
       `damaged`（损坏）：非本单实物及重复归还整次拒绝；损坏件不得再次领用；
       预约结束后仍可归还。
    4. 实物不再需要时注销（`POST /api/items/:id/deregister`）：已领出实物不能
       注销；已注销重复调用幂等返回原记录。库存缩减（`PUT /api/weights`）若使
       某规格数量低于其有效实物数，整次拒绝并保留原数据。
    5. 查询（`GET /api/items`、`GET /api/checkouts`）展示实物状态、当前占用
       领用单、每单未还件与逾期状态；预约取消、库存调整及运行状态变化均不改写
       领还历史。

## REST API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前录入数据（含避邻对与固定孔位）、数据指纹、草稿（含是否过期）、发布列表、核验列表、预约与停用列表、离心运行列表（`runs`）、设备保养状态列表（`devices`，含每台设备最新校准）、保养记录列表（`maintenances`）、设备校准记录列表（`calibrations`）、配重实物列表（`items`）、领用单列表（`checkouts`）与**设备排班列表（`schedules`，含取消/改派历史）** |
| PUT | `/api/config` | 整体替换转子配置（孔位数、容差、各孔最大承重），事务；缩小孔数使现有固定孔位越界时整次拒绝 |
| PUT | `/api/tubes` | 整体替换全部离心管，事务，校验失败回滚；替换后若留下失效避邻对（对中管不再存在）或失效固定孔位（管不存在或孔位不再可用）拒绝并保留原数据 |
| PUT | `/api/weights` | 整体替换全部配重规格，事务，校验失败回滚；库存缩减若使某规格数量低于其有效实物数（已登记未注销）则整次拒绝并保留原数据 |
| GET | `/api/exclusions` | 当前避邻对列表（按编号字典序规范化存储） |
| PUT | `/api/exclusions` | 整体替换避邻对，事务；未知编号、自配对、重复配对（含颠倒）整次拒绝并回滚 |
| GET | `/api/fixed-slots` | 当前固定孔位列表（按孔位升序规范化存储，`[{tube, hole}]`） |
| PUT | `/api/fixed-slots` | 整体替换固定孔位（整组保存/修改/清空），事务；未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定整组拒绝并回滚 |
| POST | `/api/solve` | 按当前数据（含避邻规则与固定孔位）重算草稿；无解时说明冲突（区分约束本身无解与规则冲突） |
| POST | `/api/publish` | 事务内重读数据与规则（含固定孔位）+ 求解 + 独立复核（含避邻与固定孔位）+ 冻结发布；无解返回 400 |
| GET | `/api/publications` | 发布记录列表（含当前可用性标记） |
| GET | `/api/publications/:id` | 单条冻结记录详情（含发布时数据快照） |
| POST | `/api/verifications` | 对当前可用的发布记录建立核验草稿（同一发布仅一份）；重复返回 409 + `existingId` |
| GET | `/api/verifications` | 核验列表（进度、版本、是否完成、依据发布当前是否可用） |
| GET | `/api/verifications/:id` | 核验详情（冻结快照、暂存/冻结录入；完成后附判定明细） |
| PUT | `/api/verifications/:id` | 暂存孔位录入（整表替换），须携带 `version`；过期返回 409 |
| POST | `/api/verifications/:id/complete` | 事务内重读快照与当前数据完成判定；不通过 400（原因定位孔位/孔对，草稿保留）；重复完成幂等 200 |
| POST | `/api/reservations` | 创建配重块时段预约（批次号 + 可用发布图 + UTC 起止，左闭右开）；事务内原子重读图/当前库存/重叠预约/**重叠停用**；201 新建、200 幂等重放、400 非法输入或图不可用、409 批次冲突或「占用+停用」超库存（附冲突规格与时段） |
| GET | `/api/reservations` | 预约列表（含状态、阶段、依据图当前可用性、各规格占用） |
| GET | `/api/reservations/:id` | 单条预约详情 |
| POST | `/api/reservations/:id/cancel` | 取消预约（仅未开始）；已取消幂等返回原记录；已开始 409；**其生效排班同步取消并释放设备时段（响应附 `cancelledScheduleId`）** |
| POST | `/api/suspensions` | 登记配重块临时停用（质量规格 + 正整数数量 + 原因 + UTC 起止，左闭右开）；事务内重读当前库存与重叠生效停用，超量拒绝不留记录；201 新建、400 非法输入/未知规格、409 超量（附冲突规格与时段） |
| GET | `/api/suspensions` | 停用列表（含状态、阶段 `notStarted/ongoing/ended/revoked`、是否可撤销、原因与撤销时间；含已撤销历史） |
| GET | `/api/suspensions/:id` | 单条停用详情 |
| POST | `/api/suspensions/:id/revoke` | 撤销停用（仅未开始）；已撤销幂等返回原记录；已开始/已结束 409；撤销后立即释放后续容量 |
| POST | `/api/runs` | 开始离心运行（唯一运行编号 + 非空设备编号 + 已完成核验编号 + 预约编号；开始时间服务端记录）。事务内确认核验已完成、核验与生效预约同图、发布图当前可用、当前时刻处于预约左闭右开时段、预约未被其他运行使用、**预约有生效排班时提交的设备编号必须与排班设备一致（无排班沿用原放行规则）**、同设备无进行中运行、设备保养额度未达上限（未设上限不核对）、**设备最新校准合格且到期不早于预约终点（无校准记录不核对）**；201 新建、200 同号同内容幂等重放（不重新核对保养额度、校准与排班设备）、400 非法输入/未知核验或预约、409 状态冲突（附 `existingId`/`existingRunId`，排班设备不一致附 `detail.scheduleId`/`detail.scheduledDeviceNo`，保养拒绝附 `detail.device`，校准拒绝附 `detail.calibration` 与 `detail.reason`=`failed`/`expired`），失败不留记录 |
| GET | `/api/runs` | 运行列表（运行状态、超时标记、开始/结束时间与冻结依据；冻结依据含开始时的校准记录 `frozenBasis.calibration`；依据图当前可用性仅作展示） |
| GET | `/api/runs/:id` | 单条运行详情（含冻结发布图快照、冻结核验结论、冻结预约时段与冻结校准依据；开始时设备无校准记录则 `frozenBasis.calibration` 为 `null`） |
| POST | `/api/runs/:id/complete` | 完结运行（`outcome` 为 `completed`/`aborted`；结束时间服务端记录且须晚于开始；超过预约终点如实完结并置 `timedOut`，随即释放设备、不改写预约）；201 首次完结、200 同状态幂等重放、400 非法 outcome、409 异状态改报（附 `existingOutcome`） |
| GET | `/api/devices` | 设备保养状态列表：设备编号、当前状态（空闲/运行中）、最新校准（`latestCalibration`，无记录为 `null`）与校准记录数、保养上限、本周期已用秒数与已完结次数、剩余额度、待保养标记、最近保养时间（含仅有校准记录的设备） |
| GET | `/api/devices/:deviceNo` | 单台设备保养状态（同上，含最新校准）；设备未知（无运行、上限、保养或校准记录）返回 404 |
| PUT | `/api/devices/:deviceNo/limit` | 设置/调整保养上限（`limitSeconds` 为正整数秒）；仅影响后续开始判定，不改写历史；200 返回设备状态，400 非法输入 |
| DELETE | `/api/devices/:deviceNo/limit` | 清除保养上限，设备恢复「未设置上限」的原行为（幂等 200） |
| POST | `/api/maintenances` | 登记保养（唯一保养单号 + 设备编号 + 原因；登记时刻服务端记录并开启新累计周期）；设备须空闲；201 新建、200 同号同内容幂等重放、400 非法输入、409 异内容（附 `existingId`）或设备运行中（附 `existingRunId`） |
| GET | `/api/maintenances` | 保养记录列表（单号、设备、原因、登记时间） |
| GET | `/api/maintenances/:id` | 单条保养记录；不存在返回 404 |
| POST | `/api/calibrations` | 登记设备校准（只追加：唯一校准单号 + 设备编号 + UTC 校准时间 + UTC 到期时间 + 布尔结论 `passed`）；校准时间须早于到期时间且不晚于服务端当前时刻，同设备校准时间须晚于上一条；201 新建、200 同号同内容幂等重放、400 非法输入（不留记录）、409 同号异内容（附 `existingId`）或同设备校准时间不晚于上一条（附 `existingId`，不留记录） |
| GET | `/api/calibrations` | 校准记录列表（按校准时间倒序；字段含结论 `passed` 与展示阶段 `phase`=`valid`/`failed`/`expired`）；可加 `?deviceNo=` 仅查一台设备（非法设备编号 400） |
| GET | `/api/calibrations/:id` | 单条校准记录；不存在返回 404 |
| POST | `/api/items` | 登记配重实物（唯一实物编号 + 现有质量规格）；事务内核验同规格有效实物数不超过当前库存；201 新建、200 同号同内容幂等重放（含已注销记录，不重新生效）、400 非法输入/未知规格、409 同号异内容（附 `existingId`）或有效实物数已达库存（附 `detail.{mass,capacity,active}`） |
| GET | `/api/items` | 实物列表（状态 `available/checked_out/damaged/deregistered`、当前占用领用单 `currentCheckoutId`）；可加 `?mass=` 按规格过滤（非法 400） |
| GET | `/api/items/:id` | 单条实物记录；不存在返回 404 |
| POST | `/api/items/:id/deregister` | 注销实物（仅在库/损坏可注销；已领出 409 并附占用领用单 `detail.checkoutId`）；已注销幂等返回原记录；不存在 404 |
| POST | `/api/checkouts` | 凭生效预约领用（预约编号 + 实物编号数组）：事务内确认预约生效、当前时刻处于左闭右开时段、所选实物按规格精确匹配冻结占用量、实物均在库可领；同一预约只可领用一次；201 新建、200 同内容幂等重放、400 非法输入/未知预约/未知实物、409 预约已取消/不在时段/实物被占用或损坏或注销（附 `detail.items`）/规格不匹配（附 `detail.mismatches`）/异内容重复领用（附 `existingId`）；失败不留记录 |
| GET | `/api/checkouts` | 领用单列表（冻结预约时段与占用量、逐件明细、未还件 `unreturned`、逾期 `overdue`、状态 `out/partial/returned`） |
| GET | `/api/checkouts/:id` | 单条领用单详情；不存在返回 404 |
| POST | `/api/checkouts/:id/returns` | 归还（`returns` 为 `{itemNo, condition}` 非空数组，`condition` 为 `intact`/`damaged`）：逐件标记，非本单实物及重复归还整次拒绝（409，附 `detail.{notMine,alreadyReturned}`，不留部分记录）；预约结束后仍可归还；201 完成、400 非法输入、404 领用单不存在 |
| GET | `/api/schedule?from=&to=` | 日程：各质量规格在时段内的预约占用分段（`segments`，占用超库存 `shortage`）、停用分段（`suspendedSegments`）与「占用+停用」合计分段（`combinedSegments`，合计超库存 `shortage` / 规格级 `combinedShortage`）；from/to 缺省为覆盖全部生效中预约与停用 |
| POST | `/api/schedules` | 预约设备排班（预约编号 + 非空设备编号；时段沿用预约冻结的 UTC 左闭右开时段，不由调用方提供）。同预约同设备重复提交幂等返回原记录（200）；同预约提交另一台设备为**改派**：仅允许预约未开始且未用于运行，单事务内原子释放旧设备时段并占用新设备时段，新设备冲突则回滚保留原排班（409，附 `detail.conflicts`）；已取消/已开始/已用于运行的预约不得新排班或改派（409，已用于运行附 `existingRunId`）；同设备生效排班不得重叠、首尾相接允许；201 新建/改派成功 |
| GET | `/api/schedules` | 排班占用与列表：可按 `deviceNo`、`reservationId`、`from`/`to`（左闭右开，须成对）过滤；默认仅生效排班，`?status=cancelled|reassigned` 或 `?all=1` 含历史。返回 `devices[].segments`（设备在窗口内的分段占用，每段附 `schedules`）与 `schedules`；同时给出 `deviceNo`+`from`+`to` 时附 `probe`（`available` 与冲突明细 `conflicts`，含裁剪后重叠时段） |
| GET | `/api/schedules/:id` | 单条排班详情（含 `phase`=`notStarted/ongoing/ended/cancelled/reassigned`、`usedByRun`、`cancellable`/`reassignable`、改派去向 `replacedById`）；不存在返回 404 |
| POST | `/api/schedules/:id/cancel` | 取消排班（仅生效、预约未开始且未用于运行；历史保留、释放设备时段）；已取消/已改派重复调用幂等返回原记录；已开始/已用于运行 409（后者附 `existingRunId`）。预约取消时其生效排班被**同步取消**（预约取消响应附 `cancelledScheduleId`） |

错误统一返回 `400 {"error","errors":[...]}`；状态冲突（草稿已存在、版本过期、核验已冻结、
预约批次号冲突、配重数量不足等）返回 `409` 并附带 `existingId` / `currentVersion` 等字段。
核验完成失败时 400 响应的 `detail.checks` 内带逐孔（`objectMatch`、`withinCapacity`）与
逐对（`withinTolerance`）判定，可直接用于前端高亮定位；预约数量不足（含停用占用）时 409
响应的 `detail.conflicts` 内带冲突规格、当前库存与超限时段（`windows`，含 `used` 预约占用
与 `suspended` 停用量）；停用登记超量时 409 响应结构相同（`windows[].suspended` 为已停用
数量），均可直接用于日程定位。设备排班冲突时 409 响应的 `detail.deviceNo` 标明设备、
`detail.conflicts` 给出冲突排班编号、预约编号与裁剪后的重叠时段（`overlapStart`/
`overlapEnd`）；运行开始时排班设备不一致则附 `detail.scheduleId` 与
`detail.scheduledDeviceNo`。实物领用冲突时 409 响应的 `detail.items` 标明不可领实物
（被占用附 `checkoutId`、损坏、已注销），规格不匹配时 `detail.mismatches` 给出各规格
「需 / 选」数量；归还整次拒绝时 `detail.notMine` / `detail.alreadyReturned` 分别列出
非本单实物与重复归还实物。

## 避邻对 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 维护避邻对（整体替换）：同对两管不得占据环形相邻孔位（i 与 (i+1)%N 相邻）
curl -s -X PUT $BASE/api/exclusions \
  -H 'Content-Type: application/json' \
  -d '[{"a":"T01","b":"T02"}, {"a":"T03","b":"T04"}]'
# -> {"ok":true,"currentHash":"...（规则已纳入数据指纹）"}

# 2) 查看当前避邻对（按编号字典序规范化）
curl -s $BASE/api/exclusions
# -> [{"a":"T01","b":"T02"},{"a":"T03","b":"T04"}]

# 3) 未知编号 / 自配对 / 重复配对（含颠倒）→ 400 整次拒绝，不留下部分数据
curl -s -X PUT $BASE/api/exclusions \
  -H 'Content-Type: application/json' \
  -d '[{"a":"T01","b":"T01"}]'
# -> 400 {"errors":["第 1 对避邻规则：离心管「T01」不能与自身配对（自配对无效）"]}

# 4) 替换离心管若留下失效避邻对 → 400 拒绝并保留原数据
curl -s -X PUT $BASE/api/tubes \
  -H 'Content-Type: application/json' \
  -d '[{"id":"T01","mass":50,"usableHoles":[0,1,2,3]}]'
# -> 400 {"errors":["本次离心管替换会使现有避邻对失效（对中管不再存在），已拒绝并保留原数据：",
#                   "避邻对「T01 ↔ T02」", ...]}

# 5) 草稿与发布自动纳入避邻规则
curl -s -X POST $BASE/api/solve     # 草稿：最优图满足避邻；无解时说明冲突
curl -s -X POST $BASE/api/publish   # 发布：事务内重读规则并独立复核、冻结规则与装载图

# 6) 清空避邻对（回到无规则流程）
curl -s -X PUT $BASE/api/exclusions \
  -H 'Content-Type: application/json' \
  -d '[]'
# -> {"ok":true,"currentHash":"..."}  # 指纹回到与无规则一致
```

## 固定孔位 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 0) 前置：已保存转子配置、离心管（此处 T01/T02/T03 均可用孔 0..3）与配重块
curl -s -X PUT $BASE/api/config -H 'Content-Type: application/json' \
  -d '{"holes":4,"tolerance":0.5,"holeMaxMass":[100,100,100,100]}' > /dev/null
curl -s -X PUT $BASE/api/tubes -H 'Content-Type: application/json' \
  -d '[{"id":"T01","mass":50,"usableHoles":[0,1,2,3]},
       {"id":"T02","mass":50,"usableHoles":[0,1,2,3]},
       {"id":"T03","mass":50,"usableHoles":[0,1,2,3]}]' > /dev/null
curl -s -X PUT $BASE/api/weights -H 'Content-Type: application/json' \
  -d '[{"mass":50,"quantity":1}]' > /dev/null

# 1) 维护固定孔位（整组保存/修改）：预先摆好的管按「管编号 + 孔位」登记
curl -s -X PUT $BASE/api/fixed-slots \
  -H 'Content-Type: application/json' \
  -d '[{"tube":"T02","hole":3}, {"tube":"T01","hole":1}]'
# -> {"ok":true,"currentHash":"...（绑定已纳入数据指纹）"}

# 2) 查看当前固定孔位（按孔位升序规范化）
curl -s $BASE/api/fixed-slots
# -> [{"tube":"T01","hole":1},{"tube":"T02","hole":3}]

# 3) 未知管 / 重复管或孔 / 越界孔 / 不在该管可用孔位内 → 400 整组拒绝，原绑定保留
curl -s -X PUT $BASE/api/fixed-slots \
  -H 'Content-Type: application/json' \
  -d '[{"tube":"T09","hole":0}]'
# -> 400 {"errors":["第 1 项固定孔位：离心管编号「T09」不存在于当前录入（未知编号）"]}
curl -s -X PUT $BASE/api/fixed-slots \
  -H 'Content-Type: application/json' \
  -d '[{"tube":"T01","hole":0}, {"tube":"T02","hole":0}]'
# -> 400 {"errors":["第 2 项固定孔位：孔位 0 重复绑定（每孔最多一支固定离心管）"]}

# 4) 修改管的可用孔位 / 转子孔数使绑定失效 → 整次拒绝并保留原数据
curl -s -X PUT $BASE/api/tubes \
  -H 'Content-Type: application/json' \
  -d '[{"id":"T01","mass":50,"usableHoles":[0,2,3]},
       {"id":"T02","mass":50,"usableHoles":[0,1,2,3]},
       {"id":"T03","mass":50,"usableHoles":[0,1,2,3]}]'
# -> 400 {"errors":["本次离心管替换会使现有固定孔位失效（管不再存在或孔位不再可用），已拒绝并保留原数据：",
#                   "固定孔位 1：离心管「T01」", ...]}

# 5) 草稿与发布自动纳入固定孔位：指定管必须占据指定孔位
curl -s -X POST $BASE/api/solve     # 草稿：最优图满足固定孔位；无解时说明冲突
curl -s -X POST $BASE/api/publish   # 发布：事务内重读绑定并独立复核、冻结绑定与装载图
# 冻结快照：GET /api/publications/:id -> config.fixedSlots 为发布时的绑定

# 6) 绑定变化 → 旧发布图「不可用于当前装载」（历史图不改写）；改回 → 恢复可用
curl -s -X PUT $BASE/api/fixed-slots \
  -H 'Content-Type: application/json' \
  -d '[{"tube":"T01","hole":1}]'
curl -s $BASE/api/publications/1    # -> {"usable":false, ...}

# 7) 清空固定孔位（回到无绑定流程，行为与现状一致）
curl -s -X PUT $BASE/api/fixed-slots \
  -H 'Content-Type: application/json' \
  -d '[]'
# -> {"ok":true,"currentHash":"..."}  # 指纹回到与无绑定一致
```

## 现场核验 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 查看可用发布记录（usable=true 才可发起核验）
curl -s $BASE/api/publications

# 2) 对发布记录 #1 建立核验草稿（重复建立返回 409，body 中含 existingId，可直接恢复）
curl -s -X POST $BASE/api/verifications \
  -H 'Content-Type: application/json' \
  -d '{"publicationId":1}'
# -> {"id":1,"version":1,"completed":false,"progress":{"filled":0,"total":2},
#     "entries":[{"hole":0,"ref":"","mass":0}, ...], "publication":{...冻结快照...}}

# 3) 按孔位暂存（空孔 ref:""、mass:0；有物件 ref 为编号、mass 为有限正数）
#    entries 也可写成稀疏形式 [{"hole":0,"ref":"A","mass":50.1}, ...]
curl -s -X PUT $BASE/api/verifications/1 \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"entries":[
        {"hole":0,"ref":"A","mass":50.1},
        {"hole":1,"ref":"","mass":0},
        {"hole":2,"ref":"B","mass":50.4},
        {"hole":3,"ref":"","mass":0}]}'
# -> {"version":2,"progress":{"filled":2,"total":2}, ...}
# 并发覆盖时：HTTP 409 {"errors":[...],"currentVersion":2}

# 4) 完成核验（事务内重读发布快照 + 当前数据指纹；不通过返回 400 且草稿保留）
curl -s -X POST $BASE/api/verifications/1/complete
# 201（首次通过）/ 200（重复完成，幂等返回冻结结果）
# -> {"completed":true,"completedAt":"...","frozenEntries":[...],
#     "diffSum":0.3,"checks":{"holes":[{hole,expectedRef,actualRef,
#        measuredMass,objectMatch,withinCapacity}...],
#        "pairs":[{a,b,massA,massB,diff,withinTolerance}...]}}

# 5) 不通过示例：原因定位孔位/孔对，草稿仍可 GET 恢复
# HTTP 400 {"errors":["核验不通过…：","孔 0 物件不一致：…","对径孔对（0 ↔ 2）…"],
#           "detail":{"version":2,"checks":{...}}}

# 6) 核验列表 / 单条恢复
curl -s $BASE/api/verifications
curl -s $BASE/api/verifications/1
```

## 配重块时段预约 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 创建预约：批次号 + 当前可用发布图 + UTC 起止（左闭右开 [start, end)）
#    占用量按冻结图统计；201 新建成功
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-001","publicationId":1,
       "startUtc":"2026-10-03T08:00:00Z","endUtc":"2026-10-03T12:00:00Z"}'
# -> {"id":1,"batchNo":"BATCH-001","publicationId":1,
#     "startUtc":"2026-10-03T08:00:00.000Z","endUtc":"2026-10-03T12:00:00.000Z",
#     "usage":[{"mass":50,"count":1}],"status":"active","phase":"notStarted",
#     "cancellable":true,"publicationUsable":true,...}

# 2) 幂等：同批次号同内容重复提交 → 200 返回原记录（不产生新占用）；
#    同批次号不同内容 → 409 {"existingId":1}
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-001","publicationId":1,
       "startUtc":"2026-10-03T08:00:00Z","endUtc":"2026-10-03T12:00:00Z"}'

# 3) 数量不足：409，detail.conflicts 给出冲突规格与时段，不产生任何部分占用
#    windows 内 used 为既有预约占用、suspended 为同时段临时停用数量
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-002","publicationId":1,
       "startUtc":"2026-10-03T10:00:00Z","endUtc":"2026-10-03T14:00:00Z"}'
# -> 409 {"errors":["当前可用数量不足（预约占用 + 生效停用超出当前库存），预约未产生任何占用：",
#                   "规格 50 g：2026-10-03T10:00:00.000Z 至 2026-10-03T12:00:00.000Z
#                    已预约占用 1 枚、临时停用 0 枚，本次需 1 枚，合计超出当前库存 1 枚"],
#         "detail":{"conflicts":[{"mass":50,"required":1,"capacity":1,"peak":1,
#                    "peakSuspended":0,
#                    "windows":[{"start":"...","end":"...","used":1,"suspended":0}]}]}}

# 4) 左闭右开：与既有预约终点相接的起点不冲突 → 201
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-002","publicationId":1,
       "startUtc":"2026-10-03T12:00:00Z","endUtc":"2026-10-03T14:00:00Z"}'

# 5) 取消：仅未开始的预约可取消；已取消重复调用幂等返回原记录；
#    取消后同批次号同内容重试仍返回该取消记录（不重新占用）
curl -s -X POST $BASE/api/reservations/2/cancel

# 6) 预约列表 / 单条 / 日程（from/to 可省略，缺省覆盖全部生效中预约与停用）
curl -s $BASE/api/reservations
curl -s $BASE/api/reservations/1
curl -s "$BASE/api/schedule?from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z"
# -> {"from":"...","to":"...","specs":[{
#      "mass":50,"capacity":1,"peak":1,"shortage":false,
#      "peakSuspended":1,"peakCombined":2,"combinedShortage":true,
#      "segments":[{"start":"...","end":"...","used":1,"suspended":0,"shortage":false}],
#      "suspendedSegments":[{"start":"...","end":"...","suspended":1}],
#      "combinedSegments":[{"start":"...","end":"...","used":1,"suspended":1,
#                           "shortage":true}]}]}
#    说明：segments.shortage 仅表示「预约占用 > 当前库存」（旧字段含义不变）；
#    combinedSegments.shortage 表示「预约占用 + 停用 > 当前库存」。
#    录入数量减少后：既有预约/停用不变，capacity 随之下降，超限区段 shortage=true。
```

## 预约设备排班 HTTP API 调用示例

排班把生效预约安排到具体离心设备。操作者只需提交预约编号与非空设备编号，
时段直接沿用预约冻结的 UTC 左闭右开窗口（`startUtc`/`endUtc` 不由调用方提供）。
每个预约至多一条生效排班：同预约同设备重复提交返回原记录；换设备即改派。

```bash
BASE=http://localhost:8080

# 1) 提交排班：201 新建；时段与预约冻结时段一致
curl -s -X POST $BASE/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"deviceNo":"CENT-01"}'
# -> 201 {"id":1,"reservationId":1,"deviceNo":"CENT-01",
#         "startUtc":"2026-10-05T08:00:00.000Z","endUtc":"2026-10-05T12:00:00.000Z",
#         "status":"active","phase":"notStarted","cancellable":true,"reassignable":true,
#         "usedByRun":false,"replacedById":null,"cancelledAt":null,...}

# 2) 幂等：同预约同设备重复提交 → 200 返回原记录（不产生新占用）
curl -s -X POST $BASE/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"deviceNo":"CENT-01"}'
# -> 200 {"id":1,...}（同一条记录）

# 3) 同设备时段冲突 → 409（detail.conflicts 给出冲突排班与裁剪后的重叠时段）；
#    首尾相接（一条终点 == 另一条起点）允许。
curl -s -X POST $BASE/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"reservationId":2,"deviceNo":"CENT-01"}'
# -> 409 {"errors":["设备「CENT-01」在 ... 已有生效排班占用（如排班 #1，预约 #1），
#                   同设备生效排班不能重叠（首尾相接允许），排班未产生"],
#         "detail":{"deviceNo":"CENT-01","conflicts":[{
#                    "scheduleId":1,"reservationId":1,
#                    "start":"2026-10-05T08:00:00.000Z","end":"2026-10-05T12:00:00.000Z",
#                    "overlapStart":"...","overlapEnd":"..."}]}}

# 4) 改派（同预约换设备）：仅允许预约未开始且未用于运行；
#    原子释放旧设备时段、占用新设备时段；新设备冲突则 409 且原排班保留。
curl -s -X POST $BASE/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"deviceNo":"CENT-02"}'
# -> 201 {"id":3,"reservationId":1,"deviceNo":"CENT-02","status":"active",
#         "reassignedFrom":{"scheduleId":1,"deviceNo":"CENT-01"},...}
#    旧排班 #1 保留为 status="reassigned"、replacedById=3；每个预约仍只有一条生效排班。

# 5) 已取消 / 已开始 / 已用于运行的预约不得新排班或改派 → 409
#    （已用于运行附 existingRunId；已开始同样 409）
curl -s -X POST $BASE/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"reservationId":9,"deviceNo":"CENT-09"}'
# -> 409 {"errors":["预约 #9 已取消，不能安排设备排班（历史预约保留）"]}

# 6) 取消排班：仅生效、预约未开始且未用于运行；历史保留并释放设备时段；
#    已取消/已改派重复调用幂等返回原记录。
curl -s -X POST $BASE/api/schedules/3/cancel
# -> 200 {"id":3,"status":"cancelled","cancelledAt":"...","cancellable":false,...}

# 7) 预约取消时同步取消其生效排班（级联释放占用，响应附被取消的排班编号）
curl -s -X POST $BASE/api/reservations/1/cancel
# -> {"id":1,"status":"cancelled",...,"cancelledScheduleId":3}

# 8) 按设备和时段查询占用与冲突：
#    devices[].segments 为窗口内分段占用（相接分段各自独立，每段列出排班/预约编号）；
#    给齐 deviceNo + from + to 时附 probe：available 与 conflicts。
curl -s "$BASE/api/schedules?deviceNo=CENT-01&from=2026-10-05T00:00:00Z&to=2026-10-06T00:00:00Z"
# -> {"from":"...","to":"...",
#     "devices":[{"deviceNo":"CENT-01","segments":[
#        {"start":"2026-10-05T08:00:00.000Z","end":"2026-10-05T12:00:00.000Z",
#         "schedules":[{"scheduleId":4,"reservationId":7}]}]}],
#     "schedules":[...],
#     "probe":{"deviceNo":"CENT-01","available":false,
#              "conflicts":[{"scheduleId":4,"reservationId":7,
#                            "start":"...","end":"...",
#                            "overlapStart":"...","overlapEnd":"..."}]}}
#    仅查列表（默认只含生效排班）：
curl -s "$BASE/api/schedules"
curl -s "$BASE/api/schedules?reservationId=1&all=1"     # 某预约的全部排班历史
curl -s "$BASE/api/schedules?status=cancelled"          # 仅已取消
curl -s "$BASE/api/schedules/4"                          # 单条详情（404 表示不存在）

# 9) 运行开始与排班联动：
#    - 预约有生效排班：运行提交的 deviceNo 必须等于排班设备，否则 409
#      （detail.scheduledDeviceNo 给出排班设备）；
#    - 预约无生效排班：沿用原放行规则，设备编号不做来源限制；
#    - 同运行编号同内容重放仍返回原冻结运行（200），不重新核对排班设备。
curl -s -X POST $BASE/api/runs -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-001","deviceNo":"CENT-02","verificationId":1,"reservationId":1}'
# 设备不一致时 -> 409 {"errors":["预约 #1 已排班到设备「CENT-02」（排班 #3），
#                    运行提交的设备「CENT-99」与排班不一致；运行必须在排班设备上开始"],
#                      "detail":{"scheduleId":3,"scheduledDeviceNo":"CENT-02"}}
```

排班状态字段：`status` 为 `active`（生效）/ `cancelled`（取消）/ `reassigned`（改派旧记录）；
`phase` 为 `notStarted`/`ongoing`/`ended`（生效排班相对当前时刻）或取消/改派状态本身；
`usedByRun` 表示预约是否已用于运行（一旦用于运行，排班即锁定，不可取消或改派）。
`GET /api/state` 的 `schedules` 字段包含全部排班（含历史）。

## 配重块临时停用 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 登记停用：质量规格（须为当前录入规格）+ 正整数数量 + 原因 + UTC 起止（左闭右开）
#    同规格重叠停用量累加；任一时刻不得超过登记时该规格当前库存
curl -s -X POST $BASE/api/suspensions \
  -H 'Content-Type: application/json' \
  -d '{"mass":50,"quantity":1,"reason":"送检校准",
       "startUtc":"2026-10-05T08:00:00Z","endUtc":"2026-10-05T12:00:00Z"}'
# -> 201 {"id":1,"mass":50,"quantity":1,"reason":"送检校准",
#         "startUtc":"2026-10-05T08:00:00.000Z","endUtc":"2026-10-05T12:00:00.000Z",
#         "status":"active","phase":"notStarted","revocable":true,
#         "createdAt":"...","revokedAt":null}

# 2) 登记后立即影响新预约：与停用重叠且「占用 + 停用 > 库存」的预约整单拒绝
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"BATCH-S1","publicationId":1,
       "startUtc":"2026-10-05T10:00:00Z","endUtc":"2026-10-05T11:00:00Z"}'
# -> 409 detail.conflicts[].windows[0] = {"start":"2026-10-05T10:00:00.000Z",
#    "end":"2026-10-05T11:00:00.000Z","used":0,"suspended":1}

# 3) 停用允许与既有预约重叠（既有预约不改写）；停用登记本身不核对预约占用，
#    只核对「重叠停用量 ≤ 当前库存」。

# 4) 非法输入与未知规格 → 400；超量停用 → 409（附冲突时段，且不留下任何记录）
curl -s -X POST $BASE/api/suspensions \
  -H 'Content-Type: application/json' \
  -d '{"mass":77,"quantity":1,"reason":"未知规格",
       "startUtc":"2026-10-05T08:00:00Z","endUtc":"2026-10-05T09:00:00Z"}'
# -> 400 {"errors":["未知质量规格 77 g：当前配重块录入中不存在该规格，不能登记停用"]}
curl -s -X POST $BASE/api/suspensions \
  -H 'Content-Type: application/json' \
  -d '{"mass":50,"quantity":99,"reason":"超量",
       "startUtc":"2026-10-05T08:00:00Z","endUtc":"2026-10-05T09:00:00Z"}'
# -> 409 {"errors":[...],
#         "detail":{"conflicts":[{"mass":50,"required":99,"capacity":1,"peak":0,
#                    "windows":[{"start":"...","end":"...","suspended":0}]}]}}

# 5) 撤销：仅未开始可撤销；已撤销重复调用幂等；已开始/已结束 → 409
curl -s -X POST $BASE/api/suspensions/1/revoke
# -> 200 {"id":1,"status":"revoked","phase":"revoked","revocable":false,
#         "revokedAt":"..."} （历史保留，后续容量立即释放）

# 6) 停用列表 / 单条（列表含已撤销历史）
curl -s $BASE/api/suspensions
curl -s $BASE/api/suspensions/1
```

## 离心运行 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 0) 前置：已发布且「当前可用」的装载图 #1、针对它已完成的核验 #3、
#    覆盖当前时刻的生效预约 #7（左闭右开 [start, end)）
curl -s $BASE/api/verifications   # 选 completed=true 的核验编号
curl -s $BASE/api/reservations    # 选 status=active 且 phase=ongoing 的预约编号，
                                  # 且其 publicationId 与核验依据图一致

# 1) 开始运行：唯一运行编号 + 非空设备编号 + 已完成核验编号 + 预约编号
#    开始时间由服务端记录；201 新建成功
curl -s -X POST $BASE/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-2026-001","deviceNo":"CENT-01",
       "verificationId":3,"reservationId":7}'
# -> {"id":10,"runNo":"RUN-2026-001","deviceNo":"CENT-01",
#     "verificationId":3,"reservationId":7,"publicationId":1,
#     "status":"running","outcome":null,"timedOut":false,
#     "startUtc":"2026-10-03T09:00:00.123Z","endedAt":null,
#     "frozenBasis":{
#       "publication":{"id":1,"basisHash":"...","feasible":true,
#                      "currentlyUsable":true,"config":{...},"result":{...}},
#       "verification":{"id":3,"passed":true,"diffSum":0,"massSum":100,
#                       "checks":{"holes":[...],"pairs":[...]}},
#       "reservation":{"id":7,"startUtc":"2026-10-03T08:00:00.000Z",
#                      "endUtc":"2026-10-03T10:00:00.000Z","usage":[]},
#       "reservationCurrentStatus":"active"}}

# 2) 幂等：相同运行编号同开始内容 → 200 原记录；异内容 → 409（含 existingId）
curl -s -X POST $BASE/api/runs -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-2026-001","deviceNo":"CENT-01",
       "verificationId":3,"reservationId":7}'
# -> 200 同上记录（不新增、不重复占用设备/预约）
curl -s -X POST $BASE/api/runs -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-2026-001","deviceNo":"CENT-02",
       "verificationId":3,"reservationId":7}'
# -> 409 {"errors":["运行编号「RUN-2026-001」已被使用且开始内容不同，拒绝重复提交"],
#         "existingId":10}

# 3) 典型冲突（全部 409，事务回滚、不留记录）：
#    核验未完成 / 核验与预约不同图 / 发布图当前不可用 / 不在预约时段 /
#    预约已用于其他运行（existingRunId）/ 同设备有进行中运行（existingRunId）
curl -s -X POST $BASE/api/runs -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-X","deviceNo":"CENT-09","verificationId":9,"reservationId":7}'
# -> 409 {"errors":["预约 #7 已用于运行 #10（运行编号「RUN-2026-001」），一个预约至多开始一次运行"],
#         "existingRunId":10}
# 未知核验/预约编号、空运行编号或设备编号 → 400

# 4) 完结：outcome=completed（完成）或 aborted（中止）；结束时间服务端记录、须晚于开始
curl -s -X POST $BASE/api/runs/10/complete \
  -H 'Content-Type: application/json' -d '{"outcome":"completed"}'
# -> 201 {"id":10,"status":"completed","outcome":"completed",
#         "timedOut":false,"endedAt":"2026-10-03T09:40:00.456Z",...}

# 5) 超时完结：超过预约终点（10:00:00Z）仍如实完结并标记 timedOut，设备随即释放
curl -s -X POST $BASE/api/runs/11/complete \
  -H 'Content-Type: application/json' -d '{"outcome":"aborted"}'
# -> 201 {"status":"aborted","outcome":"aborted","timedOut":true,
#         "endedAt":"2026-10-03T10:07:12.001Z",...}

# 6) 完结幂等：同状态重放 → 200 原结果（endedAt 不变）；异状态改报 → 409
curl -s -X POST $BASE/api/runs/10/complete \
  -H 'Content-Type: application/json' -d '{"outcome":"completed"}'   # 200 原结果
curl -s -X POST $BASE/api/runs/10/complete \
  -H 'Content-Type: application/json' -d '{"outcome":"aborted"}'
# -> 409 {"errors":["运行 #10 已完结为「完成」，不能改报为「中止」（完结状态已冻结）"],
#         "existingOutcome":"completed"}

# 7) 列表 / 单条（含运行状态、超时标记与冻结依据；预约后续被取消会显示
#    reservationCurrentStatus=cancelled，但运行历史不改写）
curl -s $BASE/api/runs
curl -s $BASE/api/runs/10
```

## 设备保养 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 0) 前置：设备「CENT-01」已有运行记录（见「离心运行」示例）

# 1) 设置 / 调整保养上限：按设备编号设置正整数秒数上限
#    仅影响后续开始判定，不改写运行及保养历史；返回该设备当前保养状态
curl -s -X PUT $BASE/api/devices/CENT-01/limit \
  -H 'Content-Type: application/json' \
  -d '{"limitSeconds":3600}'
# -> {"deviceNo":"CENT-01","limitSeconds":3600,"cycleStartAt":null,
#     "usedSeconds":0,"countedRuns":0,"remainingSeconds":3600,
#     "maintenanceDue":false,"running":false,"activeRunId":null,
#     "activeRunNo":null,"maintenanceCount":0,"lastMaintenanceAt":null}
# 非法上限（0 / 负数 / 小数 / 非数字）→ 400

# 2) 查看设备状态：自最近一次保养后已完结运行的累计时长、剩余额度与待保养状态
#    （尚无保养记录时计入全部已完结运行；完成/中止均计入，进行中不提前计入；
#      越过上限如实呈现——remainingSeconds 可为 0 或负数）
curl -s $BASE/api/devices/CENT-01
curl -s $BASE/api/devices          # 全部已知设备（运行/上限/保养出现过的编号）
# -> [{"deviceNo":"CENT-01","limitSeconds":3600,"usedSeconds":1.452,
#      "countedRuns":1,"remainingSeconds":3598.548,"maintenanceDue":false,
#      "running":false,...,"lastMaintenanceAt":null}, ...]

# 3) 达到上限后，开始新运行在事务内核对额度 → 409 拒绝且不留新运行
curl -s -X POST $BASE/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-2026-002","deviceNo":"CENT-01",
       "verificationId":3,"reservationId":8}'
# -> 409 {"errors":["设备「CENT-01」自最近一次保养后已完结运行累计 3601.2 秒，
#                   已达到保养上限 3600 秒（剩余额度 0 秒），设备待保养：须先登记
#                   保养开启新累计周期，再开始新的运行"],
#         "detail":{"device":{"deviceNo":"CENT-01","limitSeconds":3600,
#                    "usedSeconds":3601.2,"remainingSeconds":-1.2,
#                    "maintenanceDue":true,...}}}
# 注意：既有运行编号的幂等重放不受额度影响——同号同内容仍返回原记录（200），
#       同号异内容仍 409；未设置上限的设备不核对，沿用原行为。

# 4) 登记保养：设备空闲时凭唯一保养单号 + 设备编号 + 原因开启新累计周期
curl -s -X POST $BASE/api/maintenances \
  -H 'Content-Type: application/json' \
  -d '{"maintNo":"MAINT-2026-001","deviceNo":"CENT-01","reason":"月度保养"}'
# -> 201 {"id":1,"maintNo":"MAINT-2026-001","deviceNo":"CENT-01",
#         "reason":"月度保养","createdAt":"2026-10-04T09:00:00.123Z"}
# 登记后设备状态：usedSeconds 归零、maintenanceDue=false，可再次开始运行

# 5) 幂等：同保养单号同内容重试 → 200 返回原记录；异内容 → 409（附 existingId）；
#    设备运行中登记 → 409（附 existingRunId）
curl -s -X POST $BASE/api/maintenances \
  -H 'Content-Type: application/json' \
  -d '{"maintNo":"MAINT-2026-001","deviceNo":"CENT-01","reason":"月度保养"}'   # 200 原记录
curl -s -X POST $BASE/api/maintenances \
  -H 'Content-Type: application/json' \
  -d '{"maintNo":"MAINT-2026-001","deviceNo":"CENT-01","reason":"更换轴承"}'
# -> 409 {"errors":["保养单号「MAINT-2026-001」已被使用且登记内容不同，拒绝重复提交"],
#         "existingId":1}

# 6) 清除上限：设备恢复「未设置上限」的原行为（幂等；累计统计保留，仅不再判定）
curl -s -X DELETE $BASE/api/devices/CENT-01/limit
# -> {"deviceNo":"CENT-01","limitSeconds":null,"remainingSeconds":null,
#     "maintenanceDue":false,...}

# 7) 保养记录列表 / 单条
curl -s $BASE/api/maintenances
curl -s $BASE/api/maintenances/1
```

## 设备校准 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 0) 前置：已发布并完成核验的装载图 #1、覆盖当前时刻的生效预约 #7（同「离心运行」示例）

# 1) 登记校准（只追加）：唯一校准单号 + 设备编号 + UTC 校准/到期时间 + passed 结论
#    校准时间须早于到期时间、不晚于服务端当前时刻；同设备校准时间须晚于上一条。
curl -s -X POST $BASE/api/calibrations \
  -H 'Content-Type: application/json' \
  -d '{"calibNo":"CAL-2026-001","deviceNo":"CENT-01",
       "calibratedAt":"2026-10-01T09:00:00Z","expiresAt":"2027-10-01T09:00:00Z",
       "passed":true}'
# -> 201 {"id":1,"calibNo":"CAL-2026-001","deviceNo":"CENT-01",
#         "calibratedAt":"2026-10-01T09:00:00.000Z",
#         "expiresAt":"2027-10-01T09:00:00.000Z","passed":true,
#         "createdAt":"...","phase":"valid"}

# 2) 幂等：同号同内容重放 → 200 原记录；同号异内容 → 409（附 existingId）
curl -s -X POST $BASE/api/calibrations -H 'Content-Type: application/json' \
  -d '{"calibNo":"CAL-2026-001","deviceNo":"CENT-01",
       "calibratedAt":"2026-10-01T09:00:00Z","expiresAt":"2027-10-01T09:00:00Z",
       "passed":true}'
# -> 200 同上（不新增记录）
curl -s -X POST $BASE/api/calibrations -H 'Content-Type: application/json' \
  -d '{"calibNo":"CAL-2026-001","deviceNo":"CENT-01",
       "calibratedAt":"2026-10-01T09:00:00Z","expiresAt":"2027-10-01T09:00:00Z",
       "passed":false}'
# -> 409 {"errors":["校准单号「CAL-2026-001」已被使用且校准内容不同，拒绝重复提交"],
#         "existingId":1}

# 3) 无效输入 → 400，不留校准记录（空单号/设备、非法时间、校准不早于到期、
#    passed 非布尔、校准时间晚于服务端当前时刻）
curl -s -X POST $BASE/api/calibrations -H 'Content-Type: application/json' \
  -d '{"calibNo":"CAL-BAD","deviceNo":"CENT-01",
       "calibratedAt":"2030-01-01T00:00:00Z","expiresAt":"2031-01-01T00:00:00Z",
       "passed":true}'
# -> 400 {"errors":["校准时间 2030-01-01T00:00:00.000Z 晚于服务端当前时刻 …，不能登记未来的校准"]}

# 4) 同设备校准时间须晚于上一条：不晚于（更早或相等）→ 409，不留记录
curl -s -X POST $BASE/api/calibrations -H 'Content-Type: application/json' \
  -d '{"calibNo":"CAL-2026-002","deviceNo":"CENT-01",
       "calibratedAt":"2026-09-30T09:00:00Z","expiresAt":"2027-09-30T09:00:00Z",
       "passed":true}'
# -> 409 {"errors":["设备「CENT-01」已有校准记录 #1（校准单号「CAL-2026-001」，
#                   校准时间 2026-10-01T09:00:00.000Z）：同设备新校准时间 … 必须晚于上一条校准记录的校准时间"],
#         "existingId":1}

# 5) 列表 / 按设备过滤 / 单条（列表按校准时间倒序，只追加）
curl -s $BASE/api/calibrations
curl -s "$BASE/api/calibrations?deviceNo=CENT-01"
curl -s $BASE/api/calibrations/1

# 6) 开始运行放行：已有校准记录的设备须最新结论合格且到期不早于本次预约终点
#    （到期恰等于终点视为足够）；无校准记录的设备沿用原开始规则。
curl -s -X POST $BASE/api/runs -H 'Content-Type: application/json' \
  -d '{"runNo":"RUN-2026-010","deviceNo":"CENT-01","verificationId":3,"reservationId":7}'
# -> 201；冻结依据含校准记录：
#    frozenBasis.calibration = {"id":1,"calibNo":"CAL-2026-001","passed":true,
#                               "calibratedAt":"...","expiresAt":"..."}
# 设备无校准记录时：frozenBasis.calibration = null（沿用原开始规则）

# 7a) 最新校准不合格 → 409（不留运行）
# -> 409 {"errors":["设备「CENT-02」最新校准记录 #5（校准单号「CAL-X」）结论为不合格，不能放行运行；…"],
#         "detail":{"calibration":{...},"reason":"failed"}}
# 7b) 到期早于预约终点（有效期不足）→ 409（不留运行）
# -> 409 {"errors":["设备「CENT-02」最新校准记录 #5（…）有效期至 … 早于本次预约终点 …，
#                   校准有效期不足，不能放行运行；…"],
#         "detail":{"calibration":{...},"reason":"expired"}}

# 8) 开始成功后冻结校准依据：之后再登记新的校准记录（合格或不合格、是否到期）、
#    运行超时或完结都不改写历史运行的 frozenBasis.calibration；
#    同运行编号同内容重放仍返回原冻结记录（200，不重新核对校准）。
```

## 配重块实物领还 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 0) 前置：已录入配重规格（如 50 g × 2）、已发布可用装载图 #1（冻结占用 50 g × 1）、
#    覆盖当前时刻的生效预约 #1（左闭右开 [start, end)）
curl -s -X PUT $BASE/api/weights -H 'Content-Type: application/json' \
  -d '[{"mass":50,"quantity":2}]' > /dev/null

# 1) 登记实物：唯一实物编号 + 现有质量规格；同规格有效实物数不得超过当前库存
curl -s -X POST $BASE/api/items -H 'Content-Type: application/json' \
  -d '{"itemNo":"W50-A","mass":50}'
# -> 201 {"id":1,"itemNo":"W50-A","mass":50,"status":"available",
#         "createdAt":"...","deregisteredAt":null,"currentCheckoutId":null}
curl -s -X POST $BASE/api/items -H 'Content-Type: application/json' \
  -d '{"itemNo":"W50-B","mass":50}'   # 201（第 2 枚，达到库存上限）
curl -s -X POST $BASE/api/items -H 'Content-Type: application/json' \
  -d '{"itemNo":"W50-C","mass":50}'
# -> 409 {"errors":["规格 50 g 有效实物数 2 枚已达当前库存 2 枚，不能再登记新实物；…"],
#         "detail":{"mass":50,"capacity":2,"active":2}}
# 幂等：同号同内容 → 200 原记录；同号异内容 → 409（附 existingId）
# 未知规格 → 400 {"errors":["未知质量规格 77 g：…不能登记实物"]}

# 2) 库存缩减若低于有效实物数 → 整次拒绝并保留原数据
curl -s -X PUT $BASE/api/weights -H 'Content-Type: application/json' \
  -d '[{"mass":50,"quantity":1}]'
# -> 400 {"errors":["本次配重块录入调整会使有效实物数超过调整后库存，已拒绝并保留原数据：",
#                   "规格 50 g：有效实物 2 枚，调整后库存 1 枚", ...]}

# 3) 领用：生效预约 + 左闭右开时段内 + 所选实物按规格精确匹配冻结占用量（50 g × 1）
curl -s -X POST $BASE/api/checkouts -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"itemNos":["W50-A","W50-B"]}'
# -> 409 规格不匹配：{"errors":["…规格 50 g：预约需 1 枚，本次选 2 枚"],
#     "detail":{"required":[{"mass":50,"count":1}],"selected":[{"mass":50,"count":2}],
#               "mismatches":[{"mass":50,"required":1,"selected":2}]}}
curl -s -X POST $BASE/api/checkouts -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"itemNos":["W50-A"]}'
# -> 201 {"id":1,"reservationId":1,"startUtc":"…","endUtc":"…",
#         "usage":[{"mass":50,"count":1}],"checkedOutAt":"…","status":"out",
#         "items":[{"itemId":1,"itemNo":"W50-A","mass":50,"returned":false,
#                    "returnedAt":null,"condition":null}],
#         "unreturned":["W50-A"],"unreturnedCount":1,"overdue":false}
# 实物状态联动：GET /api/items/1 -> status="checked_out", currentCheckoutId=1

# 4) 同一预约只可领用一次：同内容重试 → 200 原单；异内容 → 409（附 existingId）
curl -s -X POST $BASE/api/checkouts -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"itemNos":["W50-A"]}'        # 200 原单（不新增记录）
curl -s -X POST $BASE/api/checkouts -H 'Content-Type: application/json' \
  -d '{"reservationId":1,"itemNos":["W50-B"]}'        # 409 {"existingId":1}
# 被其他未归还领用占用的实物 → 409：detail.items=[{"itemNo":"W50-A",
#   "status":"checked_out","checkoutId":1}]

# 5) 归还：逐件标记完好/损坏；非本单实物及重复归还整次拒绝（不留部分记录）
curl -s -X POST $BASE/api/checkouts/1/returns -H 'Content-Type: application/json' \
  -d '{"returns":[{"itemNo":"W50-B","condition":"intact"}]}'
# -> 409 {"errors":["归还整次拒绝（不留下部分记录）：","实物不属于本领用单：W50-B"],
#         "detail":{"notMine":["W50-B"],"alreadyReturned":[]}}
curl -s -X POST $BASE/api/checkouts/1/returns -H 'Content-Type: application/json' \
  -d '{"returns":[{"itemNo":"W50-A","condition":"damaged"}]}'
# -> 201 {"status":"returned","items":[{"itemNo":"W50-A","returned":true,
#         "condition":"damaged","returnedAt":"…",…}], "unreturned":[], "overdue":false}
# 重复归还 → 409（"实物已归还（重复归还）：W50-A"）
# 损坏件不得再次领用：之后用 W50-A 领用 -> 409（"已损坏（归还时报损），不得再次领用"）
# 完好归还的实物回到在库（status=available），可再次领用

# 6) 逾期与结束后归还：超过冻结预约终点仍有未还件 -> overdue=true、unreturned 列出；
#    预约结束后仍可正常归还（201）
curl -s $BASE/api/checkouts        # 列表含每单未还件与逾期状态
curl -s $BASE/api/checkouts/1      # 单条详情（冻结预约时段/占用量 + 逐件明细）

# 7) 注销：已领出实物不能注销（409，附 detail.checkoutId）；在库/损坏可注销；
#    已注销重复调用幂等返回原记录；已注销实物不能领用
curl -s -X POST $BASE/api/items/1/deregister     # 200 {"status":"deregistered",…}
curl -s -X POST $BASE/api/items/1/deregister     # 200 原记录（幂等）

# 8) 实物列表 / 单条（可按规格过滤）；预约取消、库存调整、运行状态变化均不改写
#    领还历史（领用单内为冻结的预约时段与占用量快照）
curl -s $BASE/api/items
curl -s "$BASE/api/items?mass=50"
curl -s $BASE/api/items/1
```

## 目录结构

```
src/
  server.js     Express 服务与路由、原子发布/核验/预约/停用/排班/运行/保养/校准/实物领还事务
  db.js         SQLite 连接、建表（含固定孔位表、离心运行表、设备上限/保养/校准表、
                配重实物与领用单表、预约排班表（部分唯一索引+非重叠触发器））、数据访问
  solver.js     求解器（含避邻对与固定孔位约束）、独立复核、数据指纹（纯函数，含测试）
  verify.js     现场核验：录入规整、进度、完成判定（纯函数，含测试）
  reserve.js    时段预约与临时停用：UTC 解析、冻结图占用、双层扫描线（占用+停用）
                容量判定与日程（纯函数，含测试）
  schedule.js   预约设备排班：提交规整、左闭右开设备时段重叠判定、设备占用扫描线
                与可用探测（纯函数，含测试）
  run.js        离心运行：开始/完结输入规整、左闭右开时段与超时判定（纯函数，含测试）
  maintenance.js 设备保养：上限/保养登记输入规整、累计运行时长汇总与待保养判定
                （纯函数，含测试）
  calibration.js 设备校准：校准登记输入规整、登记时序（早于到期/不晚于当前/晚于上一条）
                与开始运行放行判定（最新记录合格且到期不早于预约终点）（纯函数，含测试）
  checkout.js   配重实物领还：实物登记/领用/归还输入规整、按规格精确匹配冻结占用量、
                库存缩减核对与逾期判定（纯函数，含测试）
  validate.js   输入校验（非法质量/重复编号/越界/避邻对/固定孔位）、400/409 错误类型
public/         浏览器界面（原生 HTML/CSS/JS，无需构建）
test/           node --test 测试（求解器 + 避邻对 + 固定孔位 + HTTP API + 核验
                + 时段预约 + 临时停用 + 预约设备排班 + 离心运行 + 设备保养 + 设备校准
                + 配重实物领还，共 190 项）
Dockerfile / docker-compose.yml
```
