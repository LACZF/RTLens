# hdl-connect-view — 设计文档

一个用于阅读 Verilog / SystemVerilog 的 VSCode 插件。

版本：v0.1（初始设计）
状态：设计已评审，进入实现

---

## 1. 目标与范围

### 1.1 需求映射

| # | 需求 | 实现载体 |
|---|------|----------|
| 1 | 语法高亮 | TextMate 语法（`syntaxes/verilog.tmLanguage.json`）+ 语言配置（注释、括号、折叠、缩进） |
| 2 | 信号跳转、module 跳转 | `DocumentSymbolProvider` / `DefinitionProvider` / `ReferenceProvider` / `RenameProvider` / `HoverProvider`，基于全工作区索引 + 层次化名字解析 |
| 3 | 可视化查看信号与 module 的连接关系 | Webview 交互图（SVG 力导向布局），边为端口连接/网络，节点为实例 |
| 4 | 已生成 module 之间的组成关系 | 侧边栏 "Composition" 树视图（层次树）+ 层次路径面包屑 |
| 5 | 可视化生成 module | 从图中选中实例 → 自动生成包装 module（wrapper）源码，含端口方向/位宽推导 |

### 1.2 非目标（v0.1 明确不做）

- 完整的 IEEE 1800 语义仿真、类型检查、时序检查
- 完整的宏（`` `define ``）展开求值（仅做有限展开，见 §4.4）
- 预处理阶段的完整语义（`` `ifdef `` 内的死代码不做符号剔除，只做包含/排除两种极端）
- UVM class / constrained random 的对象图（可识别但不展开）
- 编译仿真（不调用 iverilog/verilator）

### 1.3 设计原则

1. **零原生依赖**：不引入需要 node-gyp 编译的原生模块（如 tree-sitter 绑定），保证在任何平台 `npm install && npm run compile` 都能成功。
2. **自包含前端**：Webview 资源全部随包分发，**不依赖 CDN**，保证离线/内网可用。
3. **容错优先**：RTL 解析器永不抛异常。遇到不认识的语法，跳过 token 继续，索引永远可用（IDE 场景下文件经常是半成品、语法错误的）。
4. **纯函数 + 索引**：解析产出不可变 IR；索引层只做聚合与查询，便于单测。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│  VSCode Extension Host (TypeScript)                          │
│                                                              │
│  ┌────────────┐   ┌──────────────────────────────────────┐   │
│  │ Activation │   │  Language Feature Layer              │   │
│  │ (extension │   │  symbol / definition / hover /      │   │
│  │   .ts)     │   │  references / rename                 │   │
│  └─────┬──────┘   └───────────────┬──────────────────────┘   │
│        │                          │ 查询                       │
│  ┌─────▼──────────────────────────▼──────────────────────┐   │
│  │  Index Layer   HdlIndex (单例, 按 workspace 缓存)     │   │
│  │  · moduleTable:  name -> ModuleDef[]                 │   │
│  │  · instanceTable: fileURI -> InstanceSite[]          │   │
│  │  · refIndex:  name -> RefSite[]  (token 级引用)      │   │
│  │  · hierarchy:  top -> HierarchyNode  (惰性展开)       │   │
│  └─────┬────────────────────────────────────────────────┘   │
│        │ 构建自                                                  │
│  ┌─────▼────────────────────────────────────────────────┐   │
│  │  Core Layer (与 vscode 无关, 可在 Node 下单测)       │   │
│  │  lexer.ts -> parser.ts -> ast.ts -> resolve.ts      │   │
│  │  graph.ts (拍平/还原层次)  generator.ts (生成)       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────┐        ┌──────────────────────────────┐    │
│  │ TreeView     │        │ Graph Webview               │    │
│  │ composition  │        │ media/graph.js (自研布局)    │    │
│  └──────────────┘        └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 关键决策

**决策 1：自研 Lexer + 浅层结构 Parser（而非 tree-sitter）**

- tree-sitter-verilog 需要原生编译，跨平台打包风险高；且我们只需要"结构"（module/port/instance/声明），不需要完整 AST 与错误恢复。
- 自研 Lexer 约 400 行，Parser 采用**基于分号/括号平衡的结构化扫描**（不是完整递归下降），只识别我们关心的顶层模块结构与语句类型。整体约 900 行，零依赖，100% 可测。
- 代价：不理解完整表达式语义。对本插件而言，表达式只需要"引用了哪些名字"和"常量宽度是多少"，用 token 级别的引用收集 + 常量折叠即可满足。

**决策 2：全工作区索引（Out-of-process 无关），文件变更增量更新**

- 首次激活：`workspace.findFiles` 一次取回全部匹配文件（glob 由 `core/globs.ts` 的 `braceGlob` 拼成），逐个解析并每 200 个让出一次事件循环，随后把未保存的打开文档覆盖上去。
- 更新：`onDidChangeTextDocument` 防抖 400ms → 只重解析该文件；文件监视器的 create/change → 增量重解析，delete → 移除该文件的全部 module。
- **首扫 glob 必须是普通字符串，不能是 `RelativePattern`**：`RelativePattern` 以其 base 为匹配根，而 base 只能是绝对路径或工作区文件夹，写成 `new RelativePattern('**', glob)` 时 `**` 并不是文件夹，于是 `findFiles` 一个文件都匹配不到，索引会一直是空的。真正的 `RelativePattern` 只用在每个工作区文件夹的监视器上（`new RelativePattern(folder, glob)`），这样多根工作区里同一个文件只会被处理一次。
- 排除规则由扩展自己用 `core/globs.ts` 的 `matchesGlob` 匹配相对路径与文件名，不交给 `findFiles` 的 `excludePattern`：设置里默认含 `**/tb/**`、`**/*_tb.v` 等 testbench 规则，glob 写错会静默地把 testbench 收进索引，所以这部分逻辑放在 core 里单测。
- 一次配置变更只重扫一次：重扫的唯一入口是 `hdl.connectView.refreshIndex` 命令，`IndexService` 自己不再监听 `onDidChangeConfiguration`（两处都监听会把整个工作区索引两遍）。
- 关闭文档会丢弃未保存的编辑，而索引里可能仍是缓冲区文本，因此 `onDidCloseTextDocument` 会用 `revertToDisk()` 强制重读磁盘内容。
- 索引不落盘：完整 IR 每次重开重新构建，避免序列化复杂度与陈旧数据。

**决策 3：解析在扩展进程内（不使用 Language Server）**

- 避免进程管理、端口分配、日志转发；启动即用。
- 预留 `HdlIndex` 接口，后续可无痛替换为 LSP client（`src/core` 不依赖 `vscode` 是为此留的接缝）。

---

## 3. 核心数据模型（IR）

```ts
type Pos   = { line: number; character: number };   // 0-based
type Range = { start: Pos; end: Pos };

// ---------- 词法 ----------
interface Token { kind: TokenKind; text: string; range: Range; }

// ---------- 声明 ----------
type DataType =
  | { t: 'scalar' | 'integer' | 'real' | 'time' | 'string' }
  | { t: 'logic';  signed?: boolean; range?: ValueRange }
  | { t: 'user';   name: string }              // enum / struct / typedef
  | { t: 'interface'; name: string }           // interface / modport
  | { t: 'unknown' };

interface ValueRange { msb: ConstExpr; lsb: ConstExpr }

interface ConstExpr {
  raw: string;
  value?: number;        // 折叠成功后的值
  params?: string[];     // 该表达式引用的参数名（用于参数推导）
}

type PortDir = 'input' | 'output' | 'inout' | 'ref';

// 端口：既可能声明在 module 头 (module m(a,b))，也可能声明在 body (input a)
interface PortDecl {
  name: string;          // 端口名
  declName: string;      // 内部真实信号名（.name(expr) 形式时为内部名）
  direction: PortDir;
  dataType: DataType;
  unpacked?: ConstExpr;  // 数组维度
  isInterface?: boolean;
  interfaceName?: string;
  range: Range;          // 声明位置
  nameRange: Range;      // 标识符位置（跳转用）
}

interface ParamDecl {
  name: string;
  dataType: DataType;
  value?: ConstExpr;
  isLocal: boolean;      // parameter vs localparam
  isType: boolean;       // parameter type T = ...
  range: Range;
}

interface VarDecl {
  name: string;
  dataType: DataType;
  kind: VarKind;         // 'net'|'reg'|'logic'|'var'|'typedef'|'port'|'function'|'task'|'genvar'
  range: Range;
  nameRange: Range;
  init?: ConstExpr;
}

interface FunctionDecl {
  name: string; kind: 'function'|'task';
  returnType?: DataType; args: PortDecl[]; range: Range;
}

// ---------- 模块 ----------
interface ModuleDef {
  name: string;
  kind: 'module'|'macromodule'|'interface'|'program'|'package'|'class';
  file: string;                 // 绝对路径
  range: Range;                 // module 关键字 -> 末尾 ;
  nameRange: Range;
  ports: PortDecl[];            // 有序（匹配 module 头顺序）
  portOrder: string[];          // 位置顺序
  params: ParamDecl[];
  decls: VarDecl[];             // net/reg/logic/var/typedef 声明（kind 区分）
  funcs: FunctionDecl[];
  instances: InstanceSite[];    // 本模块体内的实例
  assigns: AssignSite[];        // 顶层 assign（网表线索）
  refs: RefSite[];              // 全部标识符引用（含声明名）
  includes: string[];           // `include "..." 引用的文件
  usesUnknownConstruct: boolean;// 解析降级标记
  timeMs: number;
}

interface InstanceSite {
  name: string;                 // 实例名
  moduleName: string;           // 被例化模块名
  connections: PortConn[];      // .port(expr)
  range: Range;                 // 实例名位置
  wholeRange: Range;            // 整条实例语句
  parent: string;               // 所在 ModuleDef.name
}

interface PortConn {
  portName: string;             // 连接到的端口（连接表达式的"左"）
  exprTokens: RefSite[];        // 表达式中引用的信号（连接表达式的"右"）
  rawExpr: string;
  range: Range;
  nameRange: Range;
}

interface AssignSite {
  lhs: RefSite[];               // 赋值目标（可为拼接）
  rhs: RefSite[];
  range: Range;
  lhsRange: Range;
}

interface RefSite {
  name: string;                 // 标识符
  fullPath?: string;            // 若源码写的是 a.b.c
  range: Range;
  isWrite: boolean;             // 出现在赋值左侧 / 输出端口连接侧
  isDecl: boolean;
  kind: 'signal'|'module'|'param'|'function'|'unknown';
}
```

### 3.1 层次结构

```ts
interface HierarchyNode {
  path: string;                 // 'top.u_alu.add_result'  权威标识
  instName: string;             // 'u_alu'
  moduleName: string;           // 'alu'
  depth: number;
  parent?: HierarchyNode;
  children: HierarchyNode[];    // 惰性：首次展开时才递归
  resolved: boolean;            // moduleName 是否能在索引中找到
  file?: string;                // 定义该 module 的文件
  nameRange?: Range;            // 实例名位置（可点击跳转）
  cycle: boolean;               // 递归例化（generate 循环）标记
  truncated?: boolean;          // 超出 maxInstances 截断
}
```

- `path` 是全局唯一主键，所有 feature（跳转、图、生成）都以 `path` 交互。
- 惰性展开：只展开用户实际点开的分支，避免大设计（>10k 实例）卡死。
- **递归环检测**：深度上限 `maxDepth`（默认 32）+ 沿 path 的 `moduleName` 重复检测，命中则标记 `cycle` 并停止。

---

## 4. 解析策略

### 4.1 Lexer

产出 token 流，`kind` 至少区分：

```
ident  keyword  number  sizedNumber  realNumber  string
punct  op  directive(`define/`ifdef/`include...)  attribute
comment  macroRef(`NAME)  whitespace
```

要点：
- **数字**：支持 `4'b1010`、`'hFF`（隐式宽度）、`8'sd3`、`1_000_000`、实数 `1.5e-3`、时间 `10ns`。
- **属性** `(* ... *)` 整体作为 `attribute` token（跳过内部），属性名仍单独提取用于 `synopsys translate_off` 区域标记。
- **注释**：行注释、块注释（可嵌套的不多，但按非嵌套处理并正确吞掉 `*/` 之前的 `/*`）。
- **字符串**：处理转义 `\"`；字符串里的内容不参与引用解析。

### 4.2 Parser：模块结构扫描

不是完整语法解析，而是**结构化扫描**（对 IDE 足够，且极鲁棒）：

1. 找到 `module`/`macromodule`/`interface`/`package`/`program`/`class` 关键字 → 记录 name。
2. 从 `module` 关键字向后做 **token 深度扫描**，找出同层的第一个 `;` 或 `endmodule` 之前的内容作为 **模块头（header）**。头部可能含：
   - `#( parameter_port_list )` — 参数列表
   - ANSI 端口列表 `(input logic [7:0] a, output b)`
   - 非 ANSI 端口列表 `(a, b, c)` + body 内的 `input a;`
   - **参数写在头部列表里**：`(parameter int W = 8, input wire a)` 与 `(parameter int W = 8) (input wire a)` 都是合法 SV。头部列表按项判定：以 `parameter`/`localparam` 开头的项进 `params`，其余进 `ports`；若某个列表里只剩参数，就继续往后找下一个列表当端口表（否则真实的端口表会被参数表吞掉）。漏判的后果是 `parameter` 落到 ANSI 端口解析器、被猜一个方向，于是正确代码上出现 “Direction of W guessed” 诊断、`W` 不成为参数、`(parameter int W = 8) (input ...)` 的端口整段读不到。
   - 参数默认值用**已读到的参数 scope** 折叠：`parameter int W = 8, L = W * 2` 里 `L` 折叠为 16（`#(...)`、header 与 body 三种写法一致），否则后续端口位宽与 hover 都拿不到值。
3. 进入 body 后，按 `;` / `begin…end` 边界切分顶层条目，每条判断：
   - `wire/logic/reg/var/bit/…` → 声明
   - `assign` → AssignSite
   - `typedef` / `enum` / `struct` → 类型
   - `function`/`task` → FunctionDecl
   - `parameter`/`localparam` → ParamDecl
   - `defparam` → 参数绑定
   - `identifier [#(...)] instance_name (...)` → InstanceSite（含 generate block 递归）
   - `always/always_ff/always_comb/initial/final` → 块，记录其中的赋值（用于网表边），过程块内部按 §4.2.2 处理
4. **generate 区域**（`generate…endgenerate`、`for`/`if`/`case`）递归应用同一套 body 扫描，因此 `for (i=0;i<4;i++) begin u_arr[i] ... end` 这类会展开为多个 InstanceSite（`u_arr[0]`…），`u_arr` 本体也会记录一份索引名以便 `u_arr[0]` 形式的引用可解析。

**容错**：任何未识别条目直接跳过到下一个 `;`（花括号内跳过到匹配的 `}`）。`usesUnknownConstruct` 置位，仅用于 UI 提示"该文件解析不完整"。

**关键字表必须覆盖 parser 的分发分支**：body 分发只在 `token.kind === 'keyword'` 时进入 switch。词法漏掉一个关键字（如曾经的 `typedef`）会让整个条目被当成普通声明丢弃，因此 `parser.test.ts` 里有"词法与 parser 分发一致"的用例把二者对照。

### 4.2.1 类型表达式中的引用

`[W-1:0]`、`[cfg::UNROLL-1:0]`、`word_t w` 这类位置上的标识符是**普通的参数/类型使用**，必须进入 `refs`：

- 否则重命名参数只会改声明与部分使用，留下 `[W-1:0]` 不动，生成无法编译的代码；
- 它们同时决定语义着色（`computeTokens` 直接读 `refs`）。

- **packed 与 unpacked 是两件事**：`logic [3:0][7:0] buf` 是一个 32 位的 packed 向量，`wire [7:0] mem [0:3]` 是四个 8 位元素。解析按“范围出现在名字之前还是之后”区分（`packedDims` / `dims`，端口上是 `packed` / `unpacked`）；过去两者进同一个列表，于是 packed 多维声明的第二段被当成数组写在名字**之后**——`wire [3:0] [7:0] w;` 是另一个信号——而位宽只数了第一段，目录树说 4 位、生成器说 32 位。所有算位宽的地方（`signalWidth`、`widthOfPort`、`widthOfVar`、`declWidth`、flatten 的端口）现在都把两种维度乘进去。`selectWidth()` 还要知道“一次下标跨多少位”：`buf[2]` 是 8 位（第一个维度的一行），`mem[1]` 是一个 8 位元素，flat 向量的 `q[0]` 才是一位。参考上的 `select` 过去从不填，于是凡是要算 `base[select]` 位宽的地方拿到的都是整个网的位宽。
- **网节点与边分开算位宽**：`mem[1]` 里的 `mem` 是节点（32 位），`[1]` 是边（8 位）；过去节点用了元素位宽，一个网会窄到它最小的那个下标。
- **用户类型的位宽沿 typedef 链查**：`byte_t data;` 的 `dataType` 只有名字，宽度写在 typedef 那一侧（`typedef logic [7:0] byte_t;` 解析时记下的 `underlying`，enum 取基类型、数组 typedef 带维度、struct 不记）。`typeWidth()` 见到 `t:'user'` 就向 scope 要 `typeOf(name)`，拿到下一层类型继续折；链上的每个名字都记进 `seen`，两个 typedef 互相点名时停在 1 位而不是递归到栈溢出。resolver 由 `HdlIndex.scopeFor()` 装上，用与声明**完全相同**的可见性查名字（本 module、`lendHeaderDecls` 借进来的 header、`import` 的 package 成员），`pkg::type` 直接进 package 查；进入子实例时 `childScope()` 换成孩子自己的 resolver——两个 module 完全可以同名不同类型，父作用域折出来的宽度必须跟着声明走。没有 resolver 的 scope（解析期的临时 scope）仍按 1 位，行为与以前一致。
- **门原语名可以是信号名**：`buf`、`and`、`or`、`not` 等在词法层不是关键字（`and g1 (y, a, b);` 要被当成实例读），所以它们到达引用收集时就是标识符。过去一律跳过，于是叫 `buf` 的信号只有声明、没有任何读写：netlist 报 unused、图丢掉边。现在**原语位置**（后面跟 `(` 或 `#`）才当原语，其余当名字；`assign y = a or b;` 里的 `or` 到底是不是信号，要等整个 module 读完才知道，所以 `dropUndeclaredGateRefs()` 在模块末尾按声明表把没声明过的门词引用删掉。门原语实例也不再报 `Module "and" not found`。`naming.ts` 的策略不变：仍然拒绝把信号**改名成**门原语名。
`parseTypeAndName` 额外返回 `typeRefs`（类型部分 tokens 收集的结果），由端口（ANSI 头与 body 两种）、参数、变量声明三处调用点并入 `mod.refs`。

以 typedef 名声明的变量（`my_t data;`、`my_t arr [0:3];`、`my_t x = 8'd0;`）没有前置关键字，只能由 body 分发的 ident 分支识别：要求首 token 是本文件已知的 typedef 名，且语句形状为 `<name> ident[, …][= …];`（下标内允许任意 token）。判定足够窄，`foo.bar(1);` 与 `check_it(x);` 不会被误判为声明。

### 4.2.2 过程块内部

`always`/`initial`/`final` 的 body 由 `scanProcedural()` 递归扫描。规则都是**只读不猜**，一条规则对应一类曾经出过误报或误判的写法：

- **块标签**：`begin : name` / `fork : name` 与语句标签 `name: stmt;` 在扫描入口处被跳过。标签是块的名字，不是信号：把标签当成语句开头时，它会变成后面那条赋值 LHS 的第一个名字，于是 `begin : b` 报出 `b is not declared`，跟着的声明也一起被吞掉。
- **块内声明**：`logic t;`、`int i;`、`byte b;`、`var logic x;`、以及 typedef 名开头的 `state_t next;` 都记进 `mod.decls`，kind 按关键字分（net / reg / integer / event）。module 级过程块里的变量是 module 的**静态**变量（可以层次引用，仿真器也看得到），所以进 Nets 与图；function/task 体里的变量是**自动变量**（见下一条）。

- **子程序体是自动变量**：`function`/`task` 体里的 `byte tmp;`、`logic [7:0] shadow;` 照旧记进 `mod.decls`——体里的名字要有声明才不会被 Problems 报成未声明——但标上 `local`。做法是进函数体前记下 `mod.assigns`/`mod.decls` 的长度，扫完把这一段整体标记：子程序里不能再嵌子程序，所以这一段恰好就是这个体的全部，比把一个标记穿过每条语句、每个循环头与嵌套块要稳。Nets 与图都跳过 `local` 的赋值，于是 `tmp = x[0];` 不再是一个“被 always 驱动、没人读的 net”。`flatten` 本来就拒绝带 function/task 的 module（“a flattened copy would not compile without their bodies”），所以不存在把自动变量抄成 module 级 net 的路径；这条拒绝本身现在有用例钉住。判定只认关键字类型或**本文件已知的 typedef 名**，因此 `arr[i] = 0;`（元素赋值）不会被当成声明。
- **case item 标签**：`2'd0:`、`S0, S1:`、`default:` 整段跳过（`labelEnd()` 扫到顶层 `:` 为止，遇到 `=`、`?`、`;` 或块关键字就判定“不是标签”）。只认“标识符 + 冒号”会把 `2'd0: begin ... end` 整条分支当成一条语句吞掉，块里的声明与赋值一起丢。
- **generate 的条件**：generate `if` 的括号和 generate `case` 的选择表达式同样取名，但记为 `context: 'generate'`——读发生在**展开**时而不是运行时，Nets 视图因此写 `read by generate` 而不是 `read by always`。宏（`` `SYNTHESIS ``）不是名字，不会因为被读而产生 `"…" is not declared`。这一段过去和头部一起被跳过，只用来选分支的参数因此没有任何引用。
- **条件**：`if`/`while`/`repeat`/`case`/`wait`/`assert` 的括号里、以及 `do…while` 的条件，取出的名字按 `context: 'condition'` 记为**读**（和事件控制里的信号同一条路）。`if (en) q <= d;` 过去整段条件被丢掉，`en` 一个读者都没有，Nets 视图因此报它 unused——这正是这个视图要抓的错误。`for` 头额外处理：第一段是声明就建声明（`for (int i = 0; …)`），其余各段取读；不是声明时第一段是纯写、不记引用。`foreach (mem.bank[i, j])` 两半相反：括号前的名字（可带层次后缀）是**读**的数组，括号里的每个名字是**循环变量声明**。
- **控制结构**：body 不带 `begin` 时以 `statementEnd()` 收尾，而它对 `;` 结尾的语句返回的是“已经过去”的位置、对 `end`/`endcase` 结尾的返回的是“那个关键字本身”。两种情况都再 +1 会吃掉 body 后面的一个 token，于是紧跟一行 `assign y = …` 的单语句 `always` 会丢掉 `assign` 关键字，整条连续赋值不再被读成赋值（左侧看起来没人驱动、右侧的读看起来没被用过）。
- **赋值文本**：`lhsText`/`rhsText` 锚在 LHS 引用的起点而不是语句起点，于是 `if (a) q[1] <= d;` 写出的是 `q[1]` 与 `d`，不是空串和 `[1`。

### 4.2.3 包限定名 `pkg::NAME`

`cfg::UNROLL` 是**一条**引用：`fullPath` 为 `cfg::UNROLL`，`name`/`pathSuffix` 指向 `UNROLL`，range 覆盖两段（点击任一半都能命中），kind 取自同文件 package 内的声明。`pkg` 是作用域而不是一次使用，不会单独出现在 `referencesTo('cfg')` 里。`expandChain` 把 `::` 与 `.` 同等展开为路径元素，`descend` 第 3 步（模块名作作用域根）因此可以直接走进 package。

### 4.3 名字解析（跳转的核心）

给定光标处标识符 + 所在模块 + 层次路径，逐级解析：

```
resolve(name, scope) 优先级从高到低：
1. 若 name 是 moduleTable 的键           -> module 声明（module 跳转）
2. 若是 instanceTable 命中当前 scope 内实例名 -> 实例所在 module 声明
3. 在 scope 链上自内向外查找：
     ports  -> params -> decls -> typedefs -> funcs
4. 若 name 含 '.'（层次引用 a.b.c）：
     a  -> 必须在当前 scope 可解析；
     b  -> a 的子实例名（若 a 是 module 名则查该 module 的 ports）
     c  -> 递归，落到最终 module 的 ports/decls
5. 数组下标 a[3] / 位选 a[7:0] -> 归一化为 a 后按 4 处理，记录下标文本
6. 生成变量（genvar i / for 循环 i）-> 在 scope 的 generate 上下文中查找
7. system task/function（$display/$clog2）-> 交给 VSCode 内置，不处理
```

**名字表（解析的热路径）**：`ports/params/decls/funcs/args/instances` 这些数组过去每次查名都线性扫一遍，signal 极多的 module 会把这次扫描乘上文件里的每个标识符。`core/scopeIndex.ts` 为每个 module 懒建一张 `ScopeIndex`（`WeakMap<ModuleDef, ...>`，module 对象作 key），每个名字**首个声明胜出**——与被替换的 `.find` 完全等价；查找顺序仍由调用方决定（ports → params → decls → funcs → args → imports），这正是"两类声明同名时谁赢"的唯一出处。generate 作用域的名字带 `name\0generate` 复合键，实例同时登记裸名与 `genPrefix.name`（并记下数组下标 `idx`，`descend` 遇到两个键都命中时按下标取先出现者）。声明数组被改写的唯一地点 `lendHeaderDecls` 会 `invalidateScopeIndex(mod)` 让表重建——否则头文件后到时，先建好的表里查不到借来的名字（这条有专门的用例与变异校验）。

**跳转关系表（预计算）**：上面这套解析是跳转的语义，但不必每次按光标现场跑一遍——`buildFileJumps()`（`core/jump.ts`）在 `HdlIndex.lookupJump()` 首次被问到某个文件时，把该文件里每个可识别的标识符按同一套规则解析一次，存成按行分组的 `JumpEntry{start, end, kind, moduleName?, target?}`，同时记下这张表指向过哪些文件（`targetFiles`）。跳转时只剩两步：按行取表、按 `start <= char <= end` 判定命中（光标落在名字末尾也算），得到 `{kind, target:{file, range}}` 或 `{kind:'instance', moduleName}`。

表按文件缓存，缓存本身是**双预算 LRU**：`MAX_JUMP_TABLES = 128` 张表、`MAX_JUMP_ENTRIES = 262144` 条关系，命中即把表移到最新，淘汰从最旧的一端开始，且**永不淘汰刚插入的那张**（单文件超预算仍然可用）。失效是粒度化的，这正是"signal/module 极多时还能快速查找后跳转"的落点：

- `removeFile(f)` 只丢 `f` 自己的表，以及 `targetFiles ∋ f` 的表——指向别处的表原地保留，在一个文件里打字不会让其它打开的文件下次跳转全部重建；
- `addFile` 结束时 `missEpoch++`：保存的**命中**（有 target 的关系）仍然有效——真正变化的文件已随上一条被丢——但保存的**未命中**和无 target 的实例必须重试，新文件可能补上了它们缺的 module；
- 重名 module 出现（`byName` 里已存在）或 header 借出的声明名增减（`lendHeaderDecls` 对比借出名集合）时 `preferEpoch++`：命中"指向哪儿"这条规则本身变了（同目录优先、decls 先于 imports），命中也必须重建。同名集合没变的重复 include 不推 epoch，头文件里打字不会引发全局重建；
- 查表规则因此收敛为：prefer 没变、且（epoch 没变过或本条命中且有 target）→ 直接用表（顺手 touch）；否则重建。`missEpoch` 单独变化时命中照常返回、未命中才重建。

`moduleAtLine(file, line)`（关系表给每个词找作用域的入口）从逐 module 线性扫改为**二分查找**：`addFile` 把同文件的 module 按起始行排序（parser 本来就按序，排序是显式维持不变量），二分找起始行不晚于目标行的最后一个 module，它不包含该行就说明落在 module 之间——module 不能嵌套，一个候选就是全部答案。`lookupJump` 对不在索引里的文件仍直接返回 `undefined`。

**连通性（网表）推导**：把 InstanceSite 的 `PortConn` 与被例化 module 的 ports 结合：

- `.p(expr)`：若 `expr` 是单个信号名 → 建边 `child.port → parent.expr`；若 `expr` 是拼接 `{a, b[3:0]}` → 按位宽拆成多条边（位宽可折叠时）。
- 隐式连接 `.name(...)` 简写 → 与同名端口直连。
- 顺序连接（无命名）→ 按位置对应父模块实例的端口序（仅当被例化 module 是非 ANSI 时才允许，位置有语义）。
- `assign` 出现在模块顶层且两端都是本模块信号 → 记为"net alias"，在图上以虚线表示。

### 4.4 有限宏处理

- `` `include "path" ``：记录到 `includes`，索引器按 include 路径把被包含文件也纳入扫描（相对当前文件目录 + includeDirs 配置）。
- `` `define ``：只提取宏名与参数列表，**不做替换**；引用处记 `macroRef`。
- 原因：宏展开需要完整的条件编译求值，收益远小于复杂度；实际工程中端口/例化很少藏在宏里。若发现未例化模块，检查 `` `ifdef `` 分支是最常见原因——我们会在 UI 上给出"该 module 定义在 `ifdef 分支内或来自宏"的提示（heuristic）。

---

## 5. 各功能详细设计

### 5.1 语法高亮

`syntaxes/verilog.tmLanguage.json`，scope 名 `source.verilog`，同时注册给 `verilog` / `systemverilog` / `verilog-template`。

覆盖：
- 关键字分类着色：module 家族 / 声明类型（wire logic reg bit int）/ 流程控制 / 时序检查（posedge negedge）/ 断言
- 数字：4 种配色（十进制、基数字面量、实数、unsized `'0`）
- 编译器指令：`` `define ``/`ifdef`/`else`/`endif`/`include`/`timescale/`default_nettype/`resetall — 指令名 + 参数不同色
- 宏引用 `` `FOO ``、宏参数 `` `ARGS ``
- 属性 `(* ... *)`：属性名/属性值分色
- 类型名（大写开头的自定义类型、interface 名）与内建类型区分
- 字符串、注释（行/块/文档注释 `/** */`）
- 实例名与端口名：Parser 无法参与 TextMate 语法，故**由语义层补**：注册 `DocumentHighlight`-like 装饰 provider，对端口/实例名施加 `entity.name.tag` 风格的额外着色（通过 `DecorationType`）。这是本插件相对纯语法插件的增量价值。

`language-configuration.json`：注释、括号自动闭合、块注释、折叠标记（`//#region`）、`indentationRules`（begin/end 对齐）、wordPattern（标识符含 `_ $`）。

### 5.2 跳转

| 场景 | 触发标识符 | 结果 |
|------|-----------|------|
| module 跳转 | `alu u_alu (...)` 中的 `alu` | `module alu` 的 `nameRange` |
| instance 跳转 | `u_alu` | 同上（跳到其 module 声明）；`F2` 改为"跳到层次树节点" |
| port 跳转 | `a`（模块体内） | 端口声明处（同一模块头/端口列表） |
| signal 跳转 | `b` | 声明处（优先模块头 ANSI 声明） |
| 层次跳转 | `u_alu.x` | 逐级解析到最终信号声明 |
| param 跳转 | `WIDTH` | `parameter` 声明处 |
| func/task 跳转 | `clog2`（自定义） | 定义处 |
| 跨文件 | 任意 | 全工作区索引支持跨文件跳转 |

实现：`DefinitionProvider` 先查跳转关系表（`index.lookupJump`），命中即返回 `Location`——range 就是标识符本身，跳转后光标落在名字上而非行首；表未命中再回退到 `resolveAt()` 现场解析（回退路径与建表逻辑同源，是防止两者漂移的安全网，主路径是表）。instance 命中时用 `d.moduleName ?? d.name` 定位被例化的 module（曾经拿 instance 名去 `resolveModule`，永远解析不到——这是“instance 跳不过去”的根因之一）；`followDefinition` 关掉时改为在组成树中定位该实例。六个读索引的 provider（definition/hover/references/rename/symbols）都以 `await ensureReady()` 开头：`activate()` 同步返回、扫描在后台跑，而 VS Code 在激活完成后就会调 provider——不等的话**第一次** F12 会落在一个还空着的索引上。`coldstart.test.ts` 就是照这个场景写的：把 `findFiles` 拖住不放，先问跳转再放行。
`RenameProvider`：仅在"声明唯一"时启用（`RenameValidation` 检查），重命名时同步 module 头 + 实例名 + 层次引用（用 token 精确替换，不用正则）。
`ReferenceProvider`：基于 `refs` 索引，支持 `include`/exclude 声明。
`DocumentSymbolProvider`：module / ports / params / decls / instances / functions 的层次树，点击即跳转。
`HoverProvider`：显示 `logic [7:0] data  // input, WIDTH=8`，`wire` 显示驱动它的实例（若可解析）。

### 5.3 连接关系可视化（Webview 图）

**数据流**：extension 侧 `buildGraph(hierarchy, depth, filters)` → JSON → webview `renderGraph()`。

**节点**
- module 实例（矩形，标注实例名 + module 名 + 解析状态）
- 当前文件所在 module 高亮
- 悬停显示 ports 摘要

**边**
- 端口连接边（实线，颜色 = 方向：input/output/inout；宽度 ∝ 位宽）
- `assign` 别名边（虚线，label `assign`）
- **过程赋值边**（同样虚线，label `always`）：`always … q <= d;` 不是一根线，但它是时钟化设计唯一的“数据怎么走”的说明；只画 `assign` 时整个寄存器文件、每个 comb block 在图里都是一堆互不相连的 net
- 层次包含边（无向细线，可开关）

边的 id 由 `from>to:kind:port:signal:select` 生成，重复的赋值落在同一对 net 上会合并，因此过程赋值边不会把图按语句条数放大。条件的读（`if (en) …`）目前只进 Nets 视图，不画成边：它是控制依赖，不是数据通路，画成数据边会误导（见 §11.3）。

**布局**：自研两层 + 力导向混合
1. 层次深度 → 纵向分层（列 = 模块类型，减少交叉）
2. 同层内用简单的 Fruchterman-Reingold（迭代 300 步，带斥力/引力/向心力，收敛早停）
3. 边作为弹簧约束，端口顺序影响目标角位置（减少连线交叉）

**交互**
- 滚轮缩放 / 拖拽平移 / 拖节点（固定该节点，重跑布局）
- 悬停节点 → 高亮其一跳邻居，弱化其余
- 点击节点 → 右侧面板列出该实例的 ports 与连接对端（**可点击跳转到 RTL 对应行**）
- 搜索框：按信号名/端口名过滤，命中节点自动聚焦并高亮相关边
- "只看选中子树" / "展开全层次" / "以 C 风格连线（Bus）显示" 等开关
- 导出 SVG / PNG

**性能**：节点 > 800 时默认只画当前 module 的直接邻居（2 跳内），并提示"图过大，已降级"；JSON 分批 postMessage（每 200 节点一批）避免单条消息过大。

### 5.4 组成关系视图（TreeView）

侧边栏 `hdl-connect-view` 容器，三个视图：
1. **Composition**：`TreeDataProvider`，根为工作区所有"顶层候选"（未被任何模块例化的 module）+ 手动 pin 的 module。展开节点 = 子实例。支持：
   - `reveal(range)` — 光标所在实例自动 reveal
   - 节点图标：已解析 / 未解析（灰显 + ⚠）
   - 描述列显示 `module_name` 与文件相对路径
   - 右键：Copy Path / Reveal in Editor / 设为 Graph 根 / 展开全部子层
2. **Nets**：光标所在 module 的端口与 net/var，标注谁读、谁驱动（点击跳转到 RTL）。判定逻辑在 `src/core/nets.ts`：
   - `assign`/`always` 按 `AssignSite.lhs`/`rhs` 分读写（`inAlways` 决定标签是 `always` 还是 `assign`）；
   - 例化端口连接按**子模块端口方向**判定：`.o(n)` 驱动父级 `n`，`.i(n)` 只读，`ref` 两者皆可；子模块不在索引中时只记读，不猜；
   - `$clog2`/`$signed` 这类系统函数虽然按“读”收集，但不进 Nets：它们是语言函数，没有信号、没有位宽、也没有驱动者。
   - 通过本 module 的 generate 作用域写的读（`g[0].t`）归到块里声明的那个名字下：module 只有一个 `t`，不是每个副本一个。子实例的路径不归并（那是子 module 的网）。
   - generate `if`/`case` 的条件读标为 `read by generate`（展开时读），过程里的条件与事件控制标 `read by always`（运行时读）。
   - `@(posedge clk)` 中的信号记为 `read by always`——它不属于任何赋值点，但"没人驱动"正是这个视图要抓的错误。
3. **Problems**：三类，判定逻辑在 `src/core/problems.ts`：未解析的 module 实例（error，同一 generate 行只报一次）、方向靠猜的端口（warning）、被使用但在本 module 不可见的裸名（warning）。刻意保守：点号/作用域限定名、连到未解析实例的名字一律不报，避免把一条根因消息淹掉。
   - 名字出现在 **select 的下标**里时按同一套规则读：`bus_if.W`、`cfg::N` 是整条限定路径（`W`、`N` 不再各自被当成一个未声明的裸名），`$clog2(DEPTH)` 里的 `$clog2` 记为系统函数而不是 module 里的名字。读取侧下标里的名字照旧进 Nets；写入侧下标不记（`regs[i] <= d` 写的是 `regs`，`i` 只是读）。

这一项满足"支持已生成 module 之间的组成关系"。

### 5.5 可视化生成 module

流程（在 Graph 中选中一个实例 → 命令 `HDL: Generate Wrapper for Selection`）：

1. **选择根实例**：命令面板可选"当前文件中的实例"或"图中选中实例"；给出层次路径。
2. **推导端口**：
   - 递归收集根实例**可达**的所有实例（按 §3.1 环检测）
   - 对每个边界信号：沿传递方向判定 input/output/inout
     - 出现在子模块 `.p(sig)` 的**连接表达式位置**且该子模块端口是 output → 根的 **output**
     - 出现在子模块 `.p(sig)` 连接表达式且端口是 input → 根的 **input**
     - 同一信号在两侧都出现（inout 或多驱动）→ **inout**，并在注释里标注 ⚠ 可能多驱动
     - 子模块端口未连接（空 `.p()`）→ 丢弃
   - 合并同层级的连续位段：若多个 output 位段属于同一父信号的不同切片，合并为一个端口并保留原切片表达式（`data[15:8]`）
3. **位宽折叠**：`ConstantFolder` 对 `ConstExpr` 求值，支持 `+ - * / % << >> & | ^ ~ ?:`, 数值字面量, 参数引用链（跨模块 parameter 覆盖：`defparam` 与 `#(...)` 命名/位置覆盖都要处理）。折叠失败 → 保守取 `1`，并在生成文件头部注释里列出"未能折叠的表达式"清单。 字符串字面量按字符码折叠（`"abc"` → `0x616263`），但**拼接里出现字符串就不折叠**：连接符按每元素左移 32 位近似，对已经是字节码的字符串再移 32 位会凭空造出表达式里从来没有的数（`{NAME, "-v"}` 曾折成 2.7e16），留空比撒谎好。
4. **生成代码**：
   ```verilog
   // Auto-generated by hdl-connect-view
   // source instance : top.u_alu
   // source modules  : alu, adder
   // 深度 2, 实例 7, 端口 24
   module top_u_alu (
       input  wire        clk,
       input  wire [7:0]  a,
       output wire [7:0]  result
   );
       // ---- level 1: top.u_alu (alu) ----
       wire [7:0] result_int;
       alu u_alu (
           .clk   (clk),
           .a     (a),
           .result(result_int)
       );
       assign result = result_int;
   endmodule
   ```
   - 模块名可编辑（`QuickPick` 输入），支持"只保留选中子树"开关
   - 端口顺序稳定（字母序 + 位宽降序），保证可复现（便于 diff 与版本管理）
   - 提供 **Preview**（webview 语法着色 + 复制 / 另存为 / 插入新文件）
5. **安全阀**：生成前显示确认框，列出端口数量与多驱动警告；端口数 > 256 时拒绝并提示缩小范围。

---

## 6. 配置项

```jsonc
{
  "hdl.connectView.files": ["**/*.{v,sv,svh,vh,vlt}"],      // 纳入索引的 glob（多个模式会拼成 `{a,b}`）
  "hdl.connectView.includeDirs": ["include", "../common"], // `include 搜索目录
  "hdl.connectView.exclude": ["**/tb/**", "**/*_tb.v"],     // 排除（默认含 tb）
  "hdl.connectView.topModules": [],                          // 手动指定顶层，空则自动推断
  "hdl.connectView.maxDepth": 32,                            // 层次展开深度上限
  "hdl.connectView.maxInstances": 20000,                     // 实例总数上限（防爆）
  "hdl.connectView.graph.maxNodes": 800,                     // 图渲染上限
  "hdl.connectView.graph.showContainment": false,            // 图中默认不画层次包含边
  "hdl.connectView.enableSemanticHighlighting": true,        // 关闭后由 TextMate grammar 单独着色
  "hdl.connectView.followDefinition": true,                  // F12 跳到 module 而非层次树
}
```

---

## 7. 性能预算

| 场景 | 目标 | 手段 |
|------|------|------|
| 单文件 1 万行解析 | < 30ms | 单遍 token + 线性扫描 |
| 1000 文件 / 5MB 冷索引 | < 3s | 8 并发 + 只保留 IR（不保留 token） |
| 打开文件时补解析（缓存未命中） | < 10ms | LRU 缓存 document → ModuleDef[] |
| 跳转响应（命中已建的关系表） | < 20ms | 纯内存按行查表 + 二分 |
| 跳转响应（表未建，一次性） | 单文件、后台不可见 | `buildFileJumps` 按需建表，预算内 LRU |
| 图 200 节点首次渲染 | < 500ms | 分批 postMessage + 布局 300 步 |

内存：IR 精简为接口（无 AST 节点对象、无 token 数组），实测约 1MB/MB 源码。

实测（`node out/tools/scalePerf.js`，合成工作区，本机）：

| 规模 | 全工作区索引 | 关系表首次构建 | 稳态 jump 查询 | findDecl | moduleAtLine |
|------|--------------|----------------|----------------|----------|--------------|
| 400 module × 100 signal / 20 文件 | 583ms | 22.5ms（f0：20 module） | 433ns | 293ns | 51ns |
| 2000 module × 200 signal / 50 文件 | 7.8s | 124ms（f0：40 module） | 1.1µs | 512ns | 51ns |

索引耗时由扫描期的 parse 主导（后台进度条，与光标无关）；跳转只有**首次**查询付建表成本，之后三个热路径都是常数级，与工作区规模无关。

---

## 8. 测试策略

1. **单元测试（Node，无 vscode 依赖）**，`src/test/*.test.ts` 编译到 `out/test/` 后由 `node --test` 运行：

   | 套件 | 覆盖 | 用例数 |
   |------|------|--------|
   | `parser.test.ts` | 词法（数字/注释/属性/指令）、关键字表与 parser 分发一致、ANSI 与非 ANSI 端口、`ref` 方向、隐式 `.name` 与 `.*`、generate 展开、defparam、缺 `endmodule` 恢复、macroRef、function/task、过程赋值、层次引用、typedef 声明（三种写法与 package 内）、以 typedef 名声明的变量（标量/数组/初始化）、**文件作用域 typedef**、**package 限定类型 `p::t x;`**、**类型在本文件不可见的声明仍保留**、**无端口列表的实例化 `sub u;`**、事件控制中的信号、门级运算符不产生引用、**`bind` 语句记录被绑定的实例**（`bind`/`let` 曾被当成 block 整条丢弃）、**连续赋值产生的隐式 net**、模块体内的 `import` 语句、**enum 成员是所在作用域的常量**（`{A=2'b00, B, C}` → `A=0/B=1/C=2`，成员值里引用别的成员也算引用）、**文件作用域 enum 的成员要跟着类型一起下发**、模块自己的同名 parameter 遮蔽共享下来的成员、**package 里的 enum 成员**、**generate 块里的 `assign`/`always`/`initial`/`defparam`/`bind`**（该循环过去只认声明、参数、类型和实例）、**generate `if/else` 的 else 分支**、**命名过程块 `begin : name` / `fork : name`**、**块内局部声明**（关键字类型与 typedef 类型）、**`case` 分支标签（`2'd0:`、`default:`）**、**条件里的名字记为读**、**`for` 头声明循环变量**、**`foreach` 读数组并声明循环变量**、**单语句 `always` 之后的语句不被吃掉**、**过程赋值两侧的文本** | 60 |
   | `index.test.ts` | 声明查找、位宽折叠、参数 named/positional 覆盖传播、defparam、宏模块、generate 路径 `moduleAtPath`、层次路径不变量、深度/实例截断标记、重解析幂等（不累积旧端口/旧 module）、文件失去最后一个 module 后不留残影、重复 removeFile 幂等、**头文件后到也能经名字表查到（懒建表会失效）、同名形参按源码序先声明者胜出** | 28 |
   | `graph.test.ts` | 端口连线与方向、net 命名空间、containment、unresolved/truncated 问题、深度与节点上限、root 开关、叶子模块自身连线、**过程赋值也是边（label `always`，宽度跟着类型走）** | 25 |
   | `generator.test.ts` | flatten/compose/stub/auto、参数折叠、assign 圆锥、内部 net 报告、失败原因与回退、生成代码可被自身 parser 重新解析、**共享类型无法随副本带走时的告警**、**隐式 wire 不写进副本、也不变成 wrapper 的端口**、**enum 成员作为 localparam 写进副本**、**只有真被用到的 typedef 丢失时才告警**、**generate 块里有任何内容就回退到 stub**（线/赋值/参数/端口也算） | 30 |
   | `hierarchy.test.ts` | `signalWidth` 把声明里所有维度都算进位宽（**名字前的范围是 packed、名字后的是 unpacked**；`logic [3:0][7:0]` 是 32 而不是 4，`wire [7:0] mem [0:3]` 是 32，参数写成的范围照常折叠） | 1 |
| `coldstart.test.ts` | 冷启动：故意拖住 `findFiles`，在扫描未结束时就问 `provideDefinition`——不等索引就绪会拿到空答案 | 1 |
| `width.test.ts` | 用户类型的位宽：本 module 的 typedef、typedef 链、enum 基类型、`import` 与 `pkg::type`、文件作用域与 `` `include `` 借来的类型、数组 typedef 带维度、struct 退回 1 位、**父与子同名不同类型时各取各的**、互相点名的 typedef 不递归、无 resolver 的 scope 仍为 1、fixture `alu` 的 enum 信号 2 位 | 11 |
   | `resolve.test.ts` | 标识符合法性、workspace/模块作用域引用、包限定 `cfg::X` 解析、参数默认值与位宽中的使用、端口连接/层次读取/点号路径/未声明信号、`name` 取光标下的叶子、重命名时把限定引用收窄到叶子、**import 进来的名字解析到包里的声明**、**拒绝不完整的重命名**（import 来的名字、function/task 形参）、**task 形参解析到函数头**、**enum 成员跳进 typedef 的大括号里** | 29 |
   | `nets.test.ts` | 读/驱动方向、子端口方向决定连接侧向、事件控制中的信号、无触碰即 unused、过程赋值标 `always`、未解析子模块不猜写、**generate 块里的驱动也算驱动**、**只出现在条件里的名字算读**（`if (en) q <= d;` 里 `en` 有读者、无写者） | 13 |
   | `problems.test.ts` | 未解析 module（generate 只报一次）、猜方向端口、未声明裸名、有效代码零误报、未解析实例不产生级联、跨 module 可见性、按文件/行排序、**共享类型放在头文件时零误报**、**`import` 进来的常量/类型/task 形参零误报**、import 没列出的名字仍然报告、import 进来的 class 仍然安静、跨文件包把 ref 的 kind 定成 param、**命名过程块与块内局部变量零误报**、**`for`/`foreach` 的循环变量零误报**、**select 下标里的限定名/系统函数零误报**、**接口端口不报猜方向** | 25 |
   | `ranges.test.ts` | 位置不变量：遍历全部 fixture 与 CRLF/tab/长行/未闭合注释等 offset 密集源码，断言每个 IR 位置都在文件内、range 不倒置、token 单调不回退；含变异校验（`collect` 命中数为 0 时判失败，防止空断言） | 4 |
   | `config.test.ts` | 配置接线：`HdlConfig` 每个字段都在 config.ts 之外被读过、package.json 里每个设置都被 `readConfig` 读过、数值设置都有正的 minimum | 3 |
   | `globs.test.ts` | 排除规则（`tb/` 目录、*_tb 文件名、build/output）、`*` 不跨目录而 `**` 跨、`**/` 可匹配零层、`?` 单字符、`.` 为字面量、`braceGlob` 形状 | 5 |
   | `naming.test.ts` | 重命名保留字：`lexer.KEYWORDS` 与 `GATE_KEYWORDS` 全集都拒绝（列表必须是二者的超集，防止漂移）、会改变声明含义的关键字逐个断言、普通标识符接受、非法名字给出原因 | 5 |
   | `tokens.test.ts` | 语义 token：模块类型/实例名/端口/信号/参数/函数/typedef/系统标识符着色、点号路径只着色叶子、作用域限定偏移、排序与去重、未解析名字不着色、**类型位置的名字即使跨文件无法解析也着色**、**enum 成员的声明与使用都按 parameter 着色** | 14 |
| `jump.test.ts` | 跳转关系表：signal/module/instance 命中并给出目标范围、索引延迟就位后目标才解析出来、不可解析的名字不入表、未索引的文件不建表、光标落在名字首尾都算命中、删文件后关系表失效、**无关文件被 add 后命中表不重建、removeFile 只丢指向它的表（其余保留）、表按 LRU 淘汰（命中刷新最近序）、同目录出现新定义后命中改指向、header 借名后命中改指向** | 13 |
| `scale.test.ts` | 规模：`moduleAtLine` 二分与逐行扫描在 200 module 的每一行等价、200 signal 的 module 只看见自己的声明（名字表不串模块）、关系表构建一次复用、删文件后关系计数归零（不泄漏） | 3 |
| `providers.test.ts` | 真实 provider 借桩 `vscode` 跑起来（headless）：module 词与 instance 名跳到声明、信号读跳到声明、hover 不受影响、被排除的文件在打开前没有关系、**打开后跳转生效**、关闭后恢复 | 7 |

   共 277 个用例，因此可在无 GUI 环境运行：其中 269 个完全不依赖 `vscode` 模块，`providers.test.ts` 的 7 个与 `coldstart.test.ts` 的 1 个则由 `src/test/vscodeStub.ts` 提供的 `vscode` **桩模块**驱动——`Module._load` 拦截 `'vscode'` 后动态 `import('../extension')`，跑的是真实的 activate/scan/provider 代码，而不是复刻一份逻辑。其中 `config.test.ts` 是**接线守卫**：直接读源码双向校验“没有死设置”——`HdlConfig` 的每个字段必须在 config.ts 之外被读过，`package.json` 的每个设置必须被 `readConfig` 读过，数值设置必须有正的 `minimum`。两个方向都做过变异校验（把 `semanticHighlighting` 换成常量、往 manifest 里塞一个没人读的属性，对应用例都会失败），`ranges.test.ts` 同样做过偏移量变异校验。本轮新增的 parser/tokens/probabilities 分支也逐条做过变异校验：去掉 `isTypedefName` 里的 file-scope 分支、去掉 package 限定、`qualifiedNameAt` 的 token 数写错、取消 `shareFileTypedefs` 的自引用、忽略 module 内部遮蔽、去掉无端口列表实例化的 scope 判定、去掉 `classifyTypeUses`、`referenceTokens` 里 `kind === 'type'` 的着色分支、flatten 里“按类型聚合成一条”的告警与“本 module 已有 typedef 就不重复报”——十一处变异都会被对应用例抓住。后续两轮（隐式 net、`import`/`bind`）又逐条做了变异校验：去掉 `inAlways` 判定（过程赋值不再被判未声明）、放宽层级路径判定（`u.o` 变成一个叫 `o` 的 net）、不写 `implicit` 标记、副本与 stub 各漏一处过滤、不记录 `import` 语句、认不出 `import pkg::*`、不按名字过滤 import 列表、跨文件包不再定 kind、跳过包与自身的环、丢掉 import 名字的 owner（定义跳到别的文件）、让重命名不再拒绝、重新给 module 类型的 ref 定 kind、把 `bind`/`let` 加回 block 开关键字、不标记 bind 里的 ref——二十处变异都会被对应用例抓住。enum 那一轮又做了九处：不给第一个没有显式取值的成员补 0、不把文件作用域的成员下发到 module、不记成员的声明引用、整个 enum 解析跳过、下发之后不再重定 ref 的 kind、成员值看不到前面成员的值、无引用的 typedef 也告警、丢掉的 typedef 从不告警、把 typedef 自己算成使用者——九处都会被抓到（单元测试或 e2e 至少一处失败）。generate 那一轮又做了九处：generate 体不再分发语句、else 分支不读、不给赋值打 generate 标记、不给声明打、不给 parameter 打、生成器只拦实例、只拦 generate 里的赋值、只拦 generate 里的声明、把过程块关键字收窄成只有 `always`——九处也都会被抓住。路径那一轮（保留层级路径里的下标、按下标选 generate 副本、嵌套块路径、内联 `genvar`）又做了十二处：解析引用时不保留下标、不记下标里的名字读、嵌套循环丢掉外层标签、实例前缀被内层覆盖、光标链在下标处断开、跨文件跨 generate 块读不到信号、不按块路径选声明、数组实例元素匹配不到实例、block 切片少跳一次 `begin : label`、header 里的 `parameter` 当成端口、参数默认值在空 scope 里折叠、循环头里的内联 `genvar` 不识别——十二处都会被单元测试或 e2e 抓住（其中 `begin : label` 的两处是等价变异：else 分支的标签改由 `blockCtx` 兜底读出，行为一致）。过程块与图这一轮又做了十四处：不再跳过 `: label`、过程块里不再解析声明、case item 标签退回只认标识符、typedef 判定放宽到任意 ident（`arr[i] = 0;` 被误判成声明）、`for` 头第一段不再建声明、`foreach` 不再声明循环变量、条件不再记为读、无条件分支的 `bodyEnd + 1`、`labelEnd` 不再遇 `?`/`=` 退出、`for` 头改回按逗号切分、`integer` 关键字不再映射到 integer、nets 不再把 condition 当读、图里重新跳过 `inAlways` 赋值、过程边的 label 退回 `assign`——十四处全部会被单元测试或 e2e 抓住。select 与接口端口这一轮又做了五处：`indexRefs` 退回逐 token 平扫、`isAnsiSlice` 不认裸接口端口、`scopeKinds` 不填、猜方向的过滤里不跳过接口端口——前三处与 nets 那一处会被对应用例抓住；第四处（猜方向的过滤）是等价变异（`guessDir` 只在非 ANSI 占位端口上设置，ANSI 接口端口走 `parseAnsiPort` 的接口分支，到不了那条过滤），所以没有留在代码里。同一轮还加了一处 Nets 的：`add()` 不再把 `$` 开头的名字收进 net list（`$clog2(DEPTH)` 里的 `$clog2`），对应 nets 用例会失败。子程序体这一轮做了五处：Nets 不再跳过 `local` 的赋值、图不再跳过、赋值不标 `local`、声明不标 `local`、函数体不再算过程体——前四处会被对应用例抓住；最后“`inProcedural: false`”是等价变异（`scanFunctionBody` 根本没有例化分支，`inProcedural` 在这里没有消费者，值仍按“函数体是过程体”写）。这一轮还砍掉了两处一开始写下的代码：函数体里的 ref 标记（子程序体不产生 `context` 引用，无人消费）与 generator 里跳过 `local` 声明的过滤（`flatten` 先拒绝带 function/task 的 module，够不着）。 generate 条件这一轮做了四处（条件不记引用、记成运行时条件、Nets 丢掉它、Nets 写成 `read by always`）——四处都被对应用例抓住。generate 作用域那一轮做了五处：拒绝信息里少了参数/端口的块名、Nets 不再把 generate 路径归并、图里 `netInfo()` 不再回退到块内声明、`generateScopes()` 不看声明、路径不再去掉下标——五处都会被对应用例抓住。 位宽这一轮做了十三处：不再区分 packed 与 unpacked、没声明的门词仍算引用、门词一律当原语、参考不记 `select`、`signalWidth`/`widthOfPort`/`widthOfVar`/`declWidth` 各忽略一段维度、单比特下标仍算一位、节点用下标位宽、生成器把 unpacked 写在名字前、扁平化的多维端口没有位宽、门原语被报成缺失模块——十三处都会被对应用例抓住（头两处与 `signalWidth`/`declWidth` 两处各补了一个用例才抓住）。 收尾这一轮做了四处：跨文件的裸 interface 端口又报方向猜测、占位端口不再记录 `declaredType`、字符串拼接照旧折成假数字、compose 生成的端口方向弄错而 e2e 不查——四处都会被抓住（字符串那处第一版只挡了后置的、前置的漏了，补上 `{"ab", 4'h1}` 那个用例才抓住）。跳转关系表这一轮做了三处：instance 条目不记 `target`（查表拿不到目标，`jump.test.ts` 与 `providers.test.ts` 共 5 个用例失败）、`removeFile` 不再失效已缓存的关系表（删掉的文件仍能“跳”到过期位置，`jump.test.ts` 2 个用例失败）、打开文件时不补索引（被排除文件打开后依然没有跳转，`providers.test.ts` 1 个用例失败）——三处都会被抓住。用户类型位宽这一轮做了五处：`typeWidth` 不再向 scope 要 `typeOf`（8 个用例失败）、`scopeFor` 不装 resolver（同样 8 个）、去掉互递归的 `seen` 保护（链上打转，1 个用例栈溢出而失败）、`childScope` 不换成孩子自己的 resolver（孩子那 32 位的信号折成父 module 同名类型的 8 位，1 个失败）、`underlyingType` 不认 `pkg::type`（2 个失败）——五处都会被抓住。冷启动这一轮做了一处：`provideDefinition` 不再等索引就绪（`coldstart.test.ts` 1 个用例失败）——会被抓住。名字表与跳转关系表这一轮做了十三处：`lendHeaderDecls` 不再失效名字表（头文件后到时查不到）、`moduleAtLine` 二分差一（起始行命中的 module 查不到，scale 用例失败）、命中不 touch（缓存退化成 FIFO，LRU 用例失败）、`removeFile` 不丢指向它的表（.过关系的表残留）、`removeFile` 退回整表清空（无关文件的关系被误杀）、保存的未命中不再重试（延迟就位的 module 永远查不到）、重名 module 出现不推 `preferEpoch`（同目录新定义改不了命中，jump 用例失败）、header 借名不推 `preferEpoch`（借名后命中不改正指向）、关系表不记 `targetFiles`（删除文件时无法粒度丢表）、名字表改为后写者胜（同名形参与借名遮蔽出错）、预算条件写成 `&&`（超限不淘汰）、丢表不减关系计数（泄漏）——前十二处都会被对应用例抓住；第十三处（`descend` 实例的 `idx` 合并规则）是等价变异：`byHead && byBase` 在当前 parser 下不可能同时命中（路径按点拆段、`instances` 键没有带下标的键），idx 规则从不参与决定，保留它是因为它一字不差就是被替换的"线性扫描先出现者胜"。这一轮先跑变异、后补用例：`invalidateScopeIndex`、两处 `preferEpoch` 与后写者胜共四处一开始都活着，补了 4 个用例（`index.test.ts` 2 个 + `jump.test.ts` 2 个）才全部转红。

2. **fixture 集**：`test/fixtures/` 覆盖纯 Verilog-1995、Verilog-2001 ANSI、SystemVerilog、generate for、interface、package、宏、`ifdef` 变体。
3. **集成冒烟**（98 项 `ok`）：`src/tools/e2e.ts` 加载 fixture 目录，断言索引统计、层次与参数传播、graph 结构（含“过程赋值也在图里”）、flatten/compose/stub/auto 的可解析性与错误信息，逐项打印 `ok`，末尾输出 `ALL CHECKS PASSED`。 flatten 与 stub 的产物都回读一遍；compose 之前只查了结构，现在也回读：重建出来的端口表最容易在方向或位宽上丢东西，而回读后的 `ports` 才是用户真正拿到的 module。
4. **静态检查**：`npm run check` = `tsc --noEmit` + `e2e`；`npm test` = 编译 + 全部单测。
5. **headless provider 验收**：`providers.test.ts` 借 `vscodeStub` 激活真实扩展，逐个调用 `provideDefinition`/`provideHover`/`provideDocumentSymbols`，覆盖“激活 → 扫描 → 排除规则 → 查表跳转”的完整链路（`tb/` 里的文件在打开前没有跳转关系，打开后立即有）。VS Code 侧的 TreeView、Webview 交互、wrapper 预览/保存仍需真实 Extension Host；当前环境无 `code` CLI，尚未执行（见 §11.3）。

CI：`npm run check && npm test`（或 `make check`）。

**打包**：`make` = 装依赖（缺 `node_modules` 时）→ `tsc` → 单测 + e2e → `vsce package`，产物是 `dist/hdl-connect-view-<version>.vsix`（32 个文件、约 131 KB，含 `out/core/jump.js`、`out/core/scopeIndex.js`）。`vsce` 由 `npx --yes @vscode/vsce@4` 按需取用，不写进 `devDependencies`；离线环境可以 `make vsix VSCE=./node_modules/.bin/vsce`。`.vscodeignore` 把 `src/`、`test/`、`out/test/`、`out/tools/`、`*.js.map` 全部排除，vsix 里只剩运行时真正需要的 `out/extension.js`、`out/core`、`out/vscode`、`package.json`、语法与图标。`make contents` 打印将要打进去的文件清单。marketplace 图标必须是 PNG（`resources/icon.png`，由 `resources/icon.svg` 渲染而来），而活动栏的 `viewsContainers` 图标仍然用 SVG——两处曾经互相覆盖过一次，改动时要一起看。

---

## 9. 里程碑

| 阶段 | 交付 | 验收 |
|------|------|------|
| M1 | 脚手架 + 语法高亮 | `.v/.sv` 有配色，注释/折叠正常 |
| M2 | core：lexer/parser/indexer/resolve + 单测 | fixture 全绿 |
| M3 | 语言功能：跳转/符号/hover/references/rename | 5 类跳转全部正确 |
| M4 | Composition TreeView | 层次树可展开可跳转 |
| M5 | Graph Webview | 连接关系可交互可视化 |
| M6 | Wrapper 生成 | 生成的 module 可被仿真器接受（用 iverilog 语法检查验证） |
| M7 | 打包、README、图标 | `vsce package` 成功 |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 宏/条件编译隐藏 module 定义 | 实例显示未解析 | Problems 面板提示；支持手动指定 top；`include` 已处理 |
| generate 循环导致实例爆炸 | 卡死 | 深度/实例数双上限 + 环检测 + 截断标记 |
| 大文件超大设计（>5k 实例） | 内存/卡顿 | 惰性展开 + 图降级 + 索引并发 + 防抖 |
| 表达式语义理解不足 | 位宽错误 | 保守策略（折叠失败取 1）+ 显式警告清单，用户可手改 |
| webview 大图卡顿 | 交互卡 | 已实现：网格近似的斥力（O(n) 而非 O(n²)）+ 按帧切片布局（见 §11.4）；SVG 渲染在 800 节点内可用，超出时用 neighbourhood/子图聚焦缩小规模 |
| 平台原生依赖 | 装不上 | 零原生依赖（决策 1） |

---

## 11. 实现现状（v0.1）

### 11.1 已交付

| 能力 | 位置 | 状态 |
|------|------|------|
| 词法/语法 | `src/core/lexer.ts`、`parser.ts` | 完成；TextMate grammar 负责着色，semantic token provider 负责类型着色 |
| 着色 grammar | `syntaxes/*.tmLanguage.json` | 完成；`source.systemverilog` 只是 `source.verilog` 的 include 壳，两种语言共用一份 pattern |
| 索引与解析 | `src/core/index.ts`、`resolve.ts`、`scopeIndex.ts`、`globs.ts` | 完成；文件监视、未保存文档防抖重解析、关文档回读磁盘、`include` 展开；glob 匹配、每 module 名字表、每文件跳转关系表（LRU）都在 core，可单测 |
| 层次展开 | `src/core/hierarchy.ts` | 完成；环检测、深度与实例双上限、参数作用域求值、嵌套 generate 块路径（`ln[1].half[0]`）与分支标签（`many`）；`findByPath()` 容忍数组元素下标 |
| 连接图 | `src/core/graph.ts`、`src/vscode/graphPanel.ts` | 完成；自包含 SVG 力导向图，无 CDN/worker |
| 组成树 / nets / problems | `src/vscode/views.ts` + `core/nets.ts`、`core/problems.ts` | 完成；TreeItem 按 path 记忆供 `reveal` 复用；nets/problems 的判定逻辑在 core，可单测 |
| 跳转/hover/references/rename/符号 | `src/vscode/providers.ts` | 完成；F12 命中实例名时跳到被例化的 module（`followDefinition` 关掉则改为在组成树中定位），rename 拒绝遮蔽同名符号并只替换限定名里的叶子 |
| wrapper 生成 | `src/core/generator.ts`、`src/vscode/generate.ts` | 完成；三种策略 + auto 回退，先预览后显式保存；generate 块内的连线含循环变量时拒绝并回退 stub |
| 打包 | `package.json`、`resources/icon.svg` | 完成；`main` 指向 `out/extension.js` |

### 11.2 与设计稿的差异

- **未解析实例的激活弹窗删掉了**（用户报的"安装报错"）：`HDL: 8 instantiation(s) reference a module that is not in the index. See the HDL Problems view.` 有两个问题——8 与 Problems 视图里的 4 条对不上（toast 按 instance 数，Problems 按行+module 去重并跳过 gate 原语），而且 Problems 树本来就订阅索引变化自动刷新，toast 不提供任何新信息；索引一完成就弹，看起来更像安装失败。现在 `IndexStats.unresolvedInstances` 直接取 `problems.unresolvedInstances().length`（这条数字只有在 Problems 视图与索引日志里出现，两者永远一致）。
- **生成对话框是原生 API 组合**（QuickPick 选模式 → InputBox 改名 → 打开未保存文档预览 → modal 确认 Save/Copy/Discard），不是独立 webview。好处是代码着色、撤销、保存对话框全部由 VS Code 提供，且"写盘前必须显式确认"这条约束在代码里只有一处出口。
- **实例路径的作用域**：`buildHierarchy` 的根路径就是模块名，因此"某实例的路径"只在产生它的那棵层次树里有意义。生成流程先复用 TreeView 当前持有的层次根（`CompositionTreeProvider.hierarchyRoot`），否则在 design top 中逐个查找能容纳全部选中路径的那一棵；跨作用域的选择由 `composeModule` 明确报错，而不是生成半成品。
- **flatten 保留全部连续赋值**：flattened copy 是独立模块，删掉"看起来没人用"的 assign 会悄悄改变行为，因此一律保留；compose 才做 assign 圆锥裁剪（只复制真正喂到选中集合的赋值，并给出被丢弃数量的 warning）。
- **flatten 的 localparam 用实例处的折叠值**，而不是模块声明的默认值——`top.u_dp2 #(.DEPTH(2))` 生成的是 `localparam DEPTH = 2;`，副本与被选中的那一段设计行为一致。
- **端口数 > 256 直接拒绝**这条安全阀未实现：上限取自层次实例预算，生成的端口数天然有界。若要加，先补 `composeModule` 的计数断言。
- **图是单个自包含 webview**：`layout` 在 webview 内分帧跑，图模型经 `postMessage` 结构化克隆传入，页面里没有任何 `innerHTML`（全部 `textContent`/`setAttribute`），因此源文件名与实例名不可能变成标记。
- **拖动节点不会触发点击**：pointer 移动超过 3px 即判定为拖拽并吞掉随后那一次 `click`，否则每次挪动节点都会顺手把面板缩放到该子树。
- **重绘按帧合并**：`mousemove`/`wheel` 只排一次 `requestAnimationFrame`，不在每个事件里重建整棵 SVG；800 节点下整图重建已经超过一帧。
- **根节点也能高亮**：层次根的 `path` 是空串，图消息里的 `focus` 判空必须用 `!== undefined` 而不是真值判断，否则打开顶层 module 的图时什么都不会高亮，"只看邻居" 也就无从触发。
- §5.3 里"导出 SVG/PNG""点击节点后右侧列出 ports 面板""JSON 分批投递""超限自动降到 2 跳"均未实现：当前是单条消息投递（800 节点规模足够），超限时按配置截断并在图上标 `truncated`。
- **TreeView 的行点击命令按行类型分派**：组成树的行带 `node`，能直接给出 module 名的 range；nets 行只有文件与行号；problems 行还带列号。三个视图曾共用一个"打开"命令，而该命令直接读 `item.node`，在 nets/problems 行上会抛 `TypeError`，因此 `revealInstance` 现在同时接受两种行形状，problems 行则改绑本来就存在的 `openProblem`（唯一能定位到出错列的命令）。
- **`wordAtPosition` 的 `name` 是光标下的那个 token**，不是整条点号的第一个：`u_alu.result` 上光标停在 `result` 时 `name` 必须是 `result`。取链首会让层次信号的 find-references/rename 操作到实例名上，返回另一个符号的位置，而且 rename 会把实例名改掉。e2e 里原先断言 `name === 'dut'`（即错误行为），已按 `WordAtPosition` 的文档契约改正。
- **rename 只改叶子**：包限定引用是**一个**覆盖 `cfg::WIDTH` 两半的 range（这样 hover 与高亮覆盖整个限定名），直接 `replace` 会把 `cfg::` 一起吃掉。`core/resolve.ts` 的 `leafRangeIn()` 在 range 末尾确实是待改名叶子时才收窄，跨行或对不上则原样交给调用方，不猜。
- **rename 拒绝遮蔽**：新名字若在同一 module 作用域里已经能解析到别的声明（module 名则在工作区里已存在别的定义），直接抛错让 VS Code 提示"无法重命名"，而不是悄悄遮蔽原声明。`prepareRename` 对无法解析的名字同样抛错，避免用户输了新名字才看到"没有可重命名的内容"。
- **两个曾经是空设置的选项现在真的生效**：`followDefinition`（F12 命中实例名时跳到被例化的 module，关掉则改为在组成树里定位该实例——此前实例名的 `nameRange` 就是光标所在处，F12 什么也没做）与 `enableSemanticHighlighting`（关掉时 provider 返回空 token 集，语法高亮退回 TextMate grammar）。设置项出现在设置面板里却不做事，比没有这个设置更糟。
- **生成流程的三处修正**：预览用 preview tab（此前 `preview: false`，Discard 之后那个未命名的脏缓冲区会一直留在编辑器里，Discard 分支现在会关掉它）；模块重名与 warning 数量写进 modal 正文（toast 会被错过，而这是用户无论如何都要回答的那个提示）；树里选中的实例若已经不在任何展开后的层次里，直接报错而不是退回到光标位置或某个 design top 去包一个用户没选过的东西。
- **组成树的行描述**：child/param 计数算出来后从来没显示过（`badge` 字段是死的），现在与实例/模块对照一起进 description；根行的 description 原本重复了自己的 label，改成显示相对文件路径。
- **热路径不再重解析**：`syncOpenDocuments()` 会在每次 hover、每次跳转、每次光标移动时调用。`IndexService` 现在按文件记住上次交给索引的文本，文本没变就跳过；`selectionAt`（光标移动的主路径）干脆不调用它——`watchDocument` 的防抖已经负责脏缓冲区的重解析，而调用方把实时文本传给了 `resolveAt`。
- **文件作用域的 typedef 不再被丢掉**：头文件顶部（或第一个 module 之前）的 `typedef` 曾随其他文件作用域文本一起被跳过，于是下面每一条 `byte_t data;` 都没有声明——没有 definition、没有引用、没有 semantic token，Problems 还会报“未声明”。现在这些类型在解析前被收集、解析后分发给本文件的每个 module（module 内部同名 typedef 仍然遮蔽），并带上指向真实位置的自引用，因此类型名本身可着色、可 find-references。
- **类型名可以带 package 限定**：`p::b_t x;` 里开头的标识符不是本 module 的 typedef，整条语句曾被跳过。`qualifiedNameAt()` 统一处理 `ident` 与 `ident :: ident` 两种形状，`isTypedefName()` 认得限定名，`looksLikeDeclOf()` 按 token 数而不是字符串长度跳到声明名。
- **类型在本文件不可见的声明照样保留**：设计把共享类型放在头文件里，`byte_t data;` 里的 `byte_t` 在本文件无从解析。parser 现在区分“本文件声明的 scope 名”和“不是”，据此把 `sub u;`（无端口列表的实例化，生成 RTL 常见）读成实例、把 `byte_t data;` 读成声明。`scopeNames` 是在解析任何 module **之前**扫一遍 token 得到的，所以“module 定义在文件末尾”的前向引用也能正确判定。
- **flatten 会说清丢了类型**：副本是独立文件，头文件里的 `typedef` 跟不过去，于是 `byte_t tag;` 只能退化成同宽的 `net`/`reg`——对 enum/struct 来说那已经不是同一个信号了。现在按类型聚合成一条 warning（列出全部变量名），本 module 自己声明的 typedef 仍走原来那条“typedef 被跳过”，不重复报。
- **名字出现在类型位置就不再当成“未声明的裸名”**：`collectProblems` 与 `referenceTokens` 都按 `kind === 'type'` 放行——`classifyTypeUses()` 把本 module 声明/端口用到的类型名标成 `type`，而“类型位置”由 parser 保证，不可能是猜错。这消除了头文件类型带来的成片误报；既没声明也没用作类型的名字仍然照报。
- **连续赋值会声明它写的名字**：`assign w = a & b;` 里没有 `w` 的任何声明，Verilog 会自己造一根 1 位 wire，parser 以前当它是“未声明的裸名”，在完全合法的代码上成片报警。现在 `declareImplicitNets()` 把它补成一条 `implicit` 的 net 声明（范围指向那个名字），于是 nets 视图、hover、rename 都能看见它；生成器不写这条声明，因为副本照样会被语言自己造出来，stub 也不会因此多出一个端口。**过程赋值不一样**：`always_comb oops = data;` 里的未声明名字仍然是错误，照报。
- **`import` 记下来了**：`import cfg::K;` / `import cfg::*;` 曾被整条跳过，于是用 `K` 的地方全部报“未声明”。现在文件作用域与 module 体内的 `import` 都记进 `ModuleDef.imports`（名字连位置一起记），本文件的包由 parser 定 kind，跨文件的包由索引在 `addFile` 之后补定——`findDecl` 顺着 import 找到包里的声明，并把“声明在哪个文件/哪个作用域”一起带出来（`owner`），所以 F12 跳到的是包而不是使用点。DPI 形式（`import "DPI-C" function ...;`）不指向任何包，不记录。import 列表是白名单：没被列出的名字仍然报未声明。
- **两处重命名被明确拒绝**：import 来的名字（`import` 语句本身和别的 module 里的使用点都不是引用，改声明会把设计改坏）与 function/task 形参（声明在函数头里，函数头不是引用，非 ANSI 形参还会在函数体里再声明一次）。`core/resolve.ts` 的 `renameAllowed()` 是这条规则的唯一出处，VS Code 侧只负责把理由说成人话。
- **`bind` 不再被丢掉**：`bind`/`let` 曾被列进“嵌套块”关键字，于是整条语句被 block 解析器跳过——被绑定的实例在层次、graph、stub 里全都看不见。两者现在按语句处理；实例记在写语句的 module 上（真实位置在被绑定的 module 里，这个近似比丢掉强），连接表达式里的名字属于目标 module 的作用域，用 `RefSite.bind` 标记后不再报未声明。
- **function/task 的形参是声明**：`task automatic bump(input int n);` 里 `n` 曾是“未声明的裸名”，每一次带参调用都报警。`findDecl` 现在认形参（`kind: 'arg'`，hover 标成“function argument”），且**不**把它塞进 `decls`——它不是 module 的信号，进了 nets/graph 就是假网线。
- **enum 成员是声明**：`typedef enum logic [1:0] { RED, GREEN, BLUE } e_t;` 过去只记下类型本身，于是 `RED`/`ADD` 这种名字在整个工作区里不存在——F12 跳不过去、hover 空着、find-references 找不到、生成的副本里引用了一个谁都没定义的常量。LRM 把成员算作所在作用域的常量，所以 `parseEnumMembers()` 把每个成员记成本作用域（module 或 package）的一个 `localparam`，值是显式取值折出来的、或从上一个成员数下去的 0、1、2……；类型名放在成员的 `dataType` 上，hover 因此显示 `e_t` + 数值。文件作用域的 enum 随类型一起下发到每个 module（下发完再把仍为 unknown 的 ref 定成 param），module 自己的同名 parameter 照旧遮蔽。顺带一个效果：连续赋值里用到的成员现在会让 flatten 写出 `localparam`，副本因此能编译。
- **丢 typedef 的告警不再乱叫**：flatten 会跳过 module 自己的 typedef（副本里重建不出 enum/struct 的体），但过去无条件告警，即使整个 module 没有任何信号用这个类型——而 enum 成员现在也算参数，于是几乎每个 enum 模块都会多一条无意义的告警。现在只有当副本里确实有信号声明用了这个类型时才告警。
- **enum 成员在 hover 里带上类型**（`e_t MUL = 2`），`DECL_KIND_LABEL` 仍写 parameter，因为那正是它在语言里的身份。
- **generate 块里的语句以前整个被跳过**：`parseGenerateBody` 只认声明、参数、typedef 和实例，于是 generate-for 里的 `assign t = a[i]`、`always` 块、`defparam`、`bind` 都被逐个 token 跳过。后果有三层：netlist 说某个信号没有驱动（图上少一条连线），`regs[i] <= ...` 这种寄存器数组看起来是空的，以及**flatten 出来的副本悄悄不是那个电路**。现在该循环把语句形式交给 `parseBodyItem`（模块级同一个分发器），并且每一条 generate 里的赋值/声明/参数/端口都带上 `generate` 标记。
- **`if/else` 的 else 分支以前不读**：`matchBlock` 停在第一个分支的 `end`，于是 `generate if (...) begin : wide ... end else begin : narrow ... end` 里只有第一个分支进了 IR——而这正是写宽度相关变体的标准写法。现在 else（含 else-if 链、单语句 else）会逐个分支解析。
- **generate 块里有内容就不 flatten**（原来只拦实例，并声称"只放线和连续赋值的 generate 块没问题"）。这句话是错的：块里的 `wire t;` 每个迭代写一遍，副本里就是两条重复声明——一个不能编译的文件；而块里的赋值被丢掉后，即使能编译也不是原电路。现在声明/参数/赋值/端口/实例任一在 generate 里，就回退到 stub 并说明块里有什么、在哪个 generate 路径下。stub 始终可用。
- **两个语言各有一个 grammar scope**：`contributes.grammars` 里 verilog 与 systemverilog 曾指向同一个 `source.verilog` 文件，`.sv` 文件因此拿不到注入（声明的 scopeName 与文件里的不一致）。现在 `source.systemverilog` 是一个只 include `source.verilog` 的壳文件，pattern 只有一份。

- `module u (bus_if b)`（接口名不带 modport）现在认得出是接口端口：接口端口不带方向关键字，方向来自 modport 而非端口表，所以没有“猜方向”可言。判定依据是**本文件**里声明的 interface/class 名字（`collectScopeNames()` 的同一趟扫描顺手记下每个作用域名对应的类型）。跨文件且不带 modport 的写法仍会报“猜方向”——parser 只看得到自己这一个文件；带 modport 的 `bus_if.slave b` 跨文件一直没问题。

### 11.3 已知限制

- 无 `code` CLI，尚未在真实 Extension Host 中验收；但 Definition/Hover/Symbols 三个 provider 已由 `providers.test.ts` 在 headless 下跑通（桩 `vscode` 激活扩展 → 扫描 fixture → 逐项调 provider）。TreeView/Webview 的渲染与交互、semantic token、命令仍只做过静态检查。
- 宏不做完整展开：以宏名实例化的模块会保留为 unresolved 实例并在 Problems 面板提示。
- `always` 块只提取声明、赋值目标与条件里的读，不保留语句体；含过程逻辑、function/task、generate 内模块实例的模块一律回退为 port-forwarding stub。
- ANSI 端口的默认值（`input wire a = 1'b0`）当前不入 IR，位宽/方向不受影响，但语义 hover 不显示默认值。
- 表达式折叠失败时保守取 1 位，并在生成结果与 Problems 面板同时给出 warning。
- `bind` 的实例记在写 `bind` 语句的 module 上，而不是被绑定的 module 上；层次里多了一条边，但路径与真实 netlist 不同。- 裸 interface/class 端口在**同文件**里由 parser 认出（`opensInterface()`）；跨文件时那一项先落成占位端口，但占位端口记住了 header 里写的类型名（`declaredType`），`guessedDirections()` 见到它能在索引里解析成 interface/class 就**不再报**“方向是猜的”——interface 端口本来就没有自己的方向（由 modport 与连接决定），报出来是纯误报。类型名解析不到 interface 的仍然照报。

- 跨文件的 `typedef`（只写在头文件、头文件里没有 module）不进入索引：那里没有 module 可以挂它，所以跨文件用到的这种类型名不会被跳转到声明——只有“类型位置不报警、照常着色”这部分是完整的。
- function/task 体内的形参与局部变量不出现在 Nets 视图与图里（自动变量本来就不是 module 的 signal）：声明仍在 `decls` 里、带着 `local` 标记，形参在 `f.args` 里，两者都不进 net list。子程序体本身只提取**声明**和最简单的那种 `name = expr;` 赋值——体里的 `if`/`for`/`foreach` 条件不记为读（parser 不进子程序的语句内部），所以 Nets 里也不会多出这些名字。**module 级过程块**里的 `logic t;` 是例外：它是 module 的静态变量，会进 Nets 与图。`import` 来的名字的 find-references 只列出使用点，不含 `import` 语句本身。
- `case (op) ADD: ...` 里的 case item 不是引用点：case 的分支可以是常量、枚举成员、层次名或字面量，把它们当引用会重新制造误报，所以 `ADD` 只有声明那一侧可跳转。`foreach (a[i])` 的下标同理（循环变量由 `foreach` 自己声明）。
- 过程的**条件**进了 Nets 视图（`if (en)` 让 `en` 有读者），但**不进图**：它是控制依赖而不是数据通路，画成数据边会误导，现在只在 Nets 与语义着色里体现。
- generate 条件的表达式**进** IR：`if (WIDTH > 8)` 里的 `WIDTH` 记成 `context: 'generate'` 的读，Nets 里显示 `read by generate`，F12 与 find-references 都能到参数声明，`` `SYNTHESIS `` 这类宏不形成引用。它和过程的 `condition` 一样**不进图**（控制依赖不是数据通路）。
- generate 块里的每个迭代声明都带着块路径（`generate?: string`），解析引用、跳转、find-references、层次路径与 compose 都能按块路径区分同名副本。**写成本 module 自己的 generate 作用域的路径**（`g[0].t`）现在两边都对上了：`generateScopes()`/`generateScopedName()` 认出 `g[0]` 是本 module 的块作用域，Nets 把这样的读归到块里声明的 `t` 名下（一个信号一个条目，不再多出两个只有读者的“路径 net”），`netInfo()` 也据此解析出声明（位宽、声明位置），图里画出 `g[0].t -> y`。仍按名字平铺的是**穿过子实例的**路径：`u.g[1].q` 里的网属于 `u`，父 module 的 Nets 按原样列出，图里挂在实例 `u` 上——要看到它进了哪个 generate 块，需要进到 `u` 那一层。
- 数组化实例（`leaf u [3:0] (...)`）在层次里是**一个**节点；引用里的 `u[2]` 通过 `findByPath()` 归到该节点，但不会为每个元素生成节点。
- generate 块**内部**的 `if`（如嵌套循环里的 `if (l[0])`）会按折叠出的条件只展开走到的那一个分支，而模块顶层的 generate `if` 两个分支都保留并各带一个标签。这是已知的不一致：块内的 `if` 更像过程性条件。
- 组成视图只能生成“块内连线不读循环变量”的 generate 迭代：连线里出现 `w[i]` 时，生成器拒绝并回退 stub，因为 IR 没有把迭代常量代回连线文本。
- `bit`、`logic`、`wire`、`reg`、`signed` 等是 IEEE 保留字，光标在这些字上时层级路径会**截断**在最后一个合法段（`u.g[1].logic[0].pair` 只得到 `u.g[1]`），因为这种路径本身不是合法 SystemVerilog。
- 非 SystemVerilog 的 header 写法 `module m (.ext(in), .b(out));` 不建端口，也不报错（无诊断），保持安静不猜。
- 信号的 dataType 是用户类型但底层类型拿不到时，位宽按 1 位算：**struct/union**（IR 不记成员宽度，`underlying` 为空）、**`parameter type T = logic [WIDTH-1:0]`**（参数的默认值是类型文本，没有折成 `DataType`，所以用 `T` 声明的端口仍是 1 位）、**索引里根本查不到的名字**——三种情况都拿不到宽度，目录树、图与生成器保守取 1 位。能解析的 typedef（本 module、文件作用域、`` `include `` 借进来的、`import` / `pkg::` 指到的）都已经按底层类型给出宽度。

### 11.4 Webview 布局的规模上限

`GraphPanel` 的力导向布局按节点数分档，并且**不会阻塞 webview 主线程**：

- 斥力用网格近似：节点按 `40*sqrt(n)`（钳制在 90–220）分桶，每个节点只与自身及相邻 8 个桶内的节点计算斥力。力是 `900/d²`，在 ~130 单位外已小于 0.05，因此这个近似不影响观感，但把每轮的 O(n²) 降到接近 O(n)。
- 迭代轮数随规模递减：`n>400` 用 70 轮，`n>120` 用 130 轮，其余 260 轮。
- 每轮之间检查 `Date.now()`，一帧最多算 20ms，剩下的交给 `requestAnimationFrame` 继续；布局未收敛前先画一屏并提示 `laying out N nodes...`，收敛后再整体重绘。
- 初始位置是确定性的径向播种，重合点的抖动也由节点序号推导，所以同一张图每次布局结果一致（截图/diff 可复现）。

实测（1600 条边，本机单线程）：

| 节点数 | 旧实现（单次阻塞） | 现实现（分帧总计） |
|--------|--------------------|--------------------|
| 56 | 35ms | 60ms / 3 帧 |
| 200 | 92ms | 53ms / 3 帧 |
| 800（默认上限） | 810ms 冻结 | 119ms / 6 帧（每帧 ≤20ms） |
