# rtlens — 设计文档

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
| 3 | 可视化查看信号与 module 的连接关系 | Webview 交互图（SVG，层次分列默认、力导向可切），一个 module 一个容器框、信号是框内行，边为端口连接/网络 |
| 4 | 已生成 module 之间的组成关系 | 侧边栏 "Composition" 视图（webview 层次树，自动定位并高亮当前 module、可搜索、逐级展开/折叠） |
| 5 | 可视化生成 module | 从图中选中实例 → 自动生成包装 module（wrapper）源码，含端口方向/位宽推导 |
| 6 | 信号 / 模块追踪 | 光标处信号或模块沿层次逐跳追踪（信号：`F3` 向上到声明/上级例化、`F4` 向下到子实例连接/子端口；模块：`F3` 向上到例化它的父实例直到顶层、`F4` 向下到子模块实现文件），落点直接跳转 |
| 7 | 全局模糊搜索 module 并跳转 | 复用系统输入框：注册 `WorkspaceSymbolProvider` 把全工作区每个 module 定义喂给 VS Code 原生的「Go to Symbol in Workspace」（`#`，即 `Ctrl+T`/mac `Cmd+T`），按名字或文件路径模糊过滤，确定后打开实现文件、光标落在 module 名上；`HDL: Go to Module` 命令改为直接调起同一个系统框 |

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
- **递归环检测**：深度上限 `maxDepth`（默认 32）+ 沿 path 的 `moduleName` 重复检测，命中则标记 `cycle` 并停止。组合树（左侧层次）用独立的 `hdl.connectView.composition.maxDepth`/`maxInstances`（默认 0 = 不限），无论是否设限，环检测都会拦下自例化的 module。

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

**数据流**：extension 侧 `buildGraph(hierarchy, depth, filters)` → JSON → webview 里 `graphPanel.ts` 的内联脚本 `renderGraph()`。

**以 module 为单位分组**
- 图里不再"一个信号一个盒子"：**一个 module 一个容器框**，框的 header 是该实例（实例名 + module 名 + 解析状态），框内**一行一个信号**（名 + 位宽 + 方向）。行序默认 input → inout → output，但为此先做**跨框对齐**：每条可见的线本来就牵着两行（父 scope 的驱动 net 与子实例里同名的端口行），`orderRowsForConnections()` 把每行的 barycenter（它连到其它框的那些行的平均行号）作排序键、两边都参与、迭代到稳定——两框之间的线不再扇形交叉。没有跨框连线的行退回方向 + 名字排序
- 分组键 = 节点 id 的 `::` 前缀（instance path / net path 的作用域），`buildGroups()` 每次 `draw()` 重算——core 的 `Graph` 模型不变，分组纯粹是画法
- 当前文件所在 module 高亮；悬停显示 ports 摘要
- **上下级 module（默认都隐藏，`+`/`−` 分居左右两缘，每框默认各带一个 `+`）**：图默认只画根的框与它自己的信号——**左侧**是上级链的开关：每个框的左缘默认都带 `+`，点击揭示**紧邻的上一级**上级 module（逐级点，每点一次向上长一层，直到顶层；不再一次全揭示）；上级已显示的链上框左缘是 `−`，点击收回自己的父框及以上；若方向本来就无上级，该 `+` 是探测钮，点击确认无内容后就隐藏。**右侧**是下级的开关：每个框的右缘默认也都带 `+`，点击只揭示**该框自己**的直接子实例（再点某个子框的 `+` 只再长出那个框的一层，直到叶子；该框已展开时显示 `−` 收回自己的下级）；无子实例的叶子框、或子实例不在焦点子树里的框（如祖先上下文框），右缘 `+` 同样是探测钮，点击确认无可揭示的下级后就隐藏。上下两侧的展开都**按 module 各自独立**、可逐级收回，没有"一次全展开/收回"的全局开关。`ancestorsShown`/`ancestorsLeft` 与已展开的路径集合（`expanded`）随每次 graph 消息回传，扩展端把该集合作为 `GraphOptions.expanded`（`Set<string>`/`string[]`；`undefined` = 预算模式全展开）交给 `core/graph.ts`，`visit()` 在展开模式里对每个框都画自己的作用域（`connectScope`），但只有 `expanded` 里的路径才递归画子实例；webview 本地先改集合让框即时响应。一个 mid-tree module 因此不再画成无父无外源信号的封闭盒子，而画成"先 + 再 +"逐步长出的上下文 + 逐步长出的下级；同一 module 的其它例化点（兄弟实例）不画，只走当前这条链。**有上级可揭示的前提是先找到上级**：从 module 的**定义**（裸 module 根，如右键 `adder`）打开图时，这条定义看不出谁例化了它，于是 `GraphPanel.setNode` 用 `HdlIndex.instantiatorsOf` 反向走索引、由 `core/hierarchy.ts` 的 `containingDesign` 自底向上走到"最近的"设计根（同层再按配置的 `topModules` 优先），把走查重定到该设计——于是 `chip_top → datapath → adder` 成为 `chip_top.u_dpath.u_adder` 的真实实例链、`datapath`/`chip_top` 可被左缘 `+` 揭示；模块本身是顶层（无人例化）时链为空、根的左缘 `+` 即探测钮。

**边锚到框里的信号行**
- `anchorOf(node, other, edge)`：按对端容器中心选**朝向对方的那一侧**，x 取框的左/右边缘；net 端的 y 是它在框里那一行的行中心，instance 端按 `e.port`/`e.signal` 在**对端框内**找同名信号行（`portRow`），命中就锚到那一行，找不到才落到 header 中心——线因此接进模块内部的那根信号，而不是撞在外框上
- 同一框内的连线（`assign`/`always` 这类 net→net）画成框右侧外凸的弓形，两端都从右边缘出去，不穿框
- 端口连接边（实线，颜色 = 方向：input/output/inout；宽度 ∝ 位宽）
- `assign` 别名边（虚线，label `assign`）
- **过程赋值边**（同样虚线，label `always`）：`always … q <= d;` 不是一根线，但它是时钟化设计唯一的“数据怎么走”的说明；只画 `assign` 时整个寄存器文件、每个 comb block 在图里都是一堆互不相连的 net
- 层次包含边（无向细线，可开关）

边的 id 由 `from>to:kind:port:signal:select` 生成，重复的赋值落在同一对 net 上会合并，因此过程赋值边不会把图按语句条数放大。条件的读（`if (en) …`）目前只进 Nets 视图，不画成边：它是控制依赖，不是数据通路，画成数据边会误导（见 §11.3）。

**两层折叠**
- **信号折叠（webview 本地）**：点 header 上的 chevron 折叠/展开该 module 的信号行，框缩成 header（`HEAD_H`）；行上的连线**回退锚到 header**，连接不会消失。状态只是脚本里的一个 `Set`，只改画法，不惊动扩展
- **层次折叠（扩展）**：双击 header → `toggleCollapse` → `buildGraph` 收起子树与该作用域的 net，框上标 `+`（无信号的框只有 `+` 没有 chevron）；两个集合各自独立，互不覆盖

**布局**：层次分列为默认，力导向可切回
1. 层次深度 → 按列排布（列 = 层次层级，**列里堆的是容器框**，列内按 key 排序、列居中），连线沿列从左到右走
2. `hierarchy layout` 关掉时退回力导向：**按容器框跑**（`runForce(groups)`，框宽高参与斥力），确定性径向播种 + Fruchterman-Reingold（分帧迭代，收敛早停）
3. 布局状态按 scope 记在 `gpos`（`{x, y, moved, laid}`）：graph 消息只重置 `laid`（用户拖过的位置留着），切换布局开关才连 `moved` 一起重置，否则列坐标会被当成已收敛结果冻住

**交互**
- 滚轮缩放 / 拖拽平移 / 拖框（固定该框，重跑布局）
- 悬停 / 搜索：`withGroups()` 把命中集扩成**整容器**（搜一个信号，它所在的 module 连同全部信号一起画出来），过滤与邻域都走这一条；命中只用于"只看邻居"的过滤，**不再让其它 module 变暗**——所有框与连线始终按正常不透明度显示
- **双击 header 按层次折叠**（见上），单击仍延迟 200ms 才发 `focus`
- 图例带一行 hint，说明 chevron / 双击 `+`（层次折叠）/ 框缘 `+`（左=上级、右=下级）各自是什么
- "只看选中子树" / "展开全层次" / "以 C 风格连线（Bus）显示" 等开关
- 点击节点 → 右侧面板列出该实例的 ports 与连接对端（**可点击跳转到 RTL 对应行**）
- 导出 SVG / PNG

**性能**：节点 > 800 时默认只画当前 module 的直接邻居（2 跳内），并提示"图过大，已降级"；单条 postMessage 投递（800 节点规模足够）。

### 5.4 组成关系视图（Webview + 搜索）

侧边栏 `rtlens` 容器，三个视图：
1. **Composition**：`WebviewViewProvider`（原生 TreeView 放不下搜索框，故用 webview），根为单个 module 的例化树。**层次规模由独立的 `hdl.connectView.composition.maxDepth`/`maxInstances` 控制（默认都 0 = 不限）**：`IndexService.compositionHierarchy`/`containingDesign` 把这两个值透传给 `buildHierarchy`（显式 0 表示不设限，省略仍是历史默认 32/20000），因此组合树不受全局 `maxDepth`/`maxInstances` 约束。**跟随编辑器但树不搬家**：根固定在整个设计上——`hdl.connectView.topModules` 非空时取其中第一个在索引里存在的名字为根；为空时由 `containingDesign` 向上走到**包含当前 module 的设计顶层**（模块自身即顶层、无人例化时就是它自己）。活动编辑器切换时只在**根会变**（换到另一份设计）时重建，否则保持现有树的展开/折叠状态不动；当前行由 `{type:'highlightPath', path}` 定位——`locate` 在树里按 module 名找到最近的一行（根行匹配根 module，否则 BFS 取第一个同名实例），**若光标正落在某个例化上（整个例化语句的字符范围 `InstanceSite.range`——例化名 `u_ctrl`、所例化的模块名 `control`、以及它接线的每一行如 `.busy(busy)`/`.a(operand_a)`，含 `#(...)` 参数覆盖）就把高亮下移到该例化行 `chip_top.u_ctrl`，否则停在 module 行**（`instanceLocalAt` + `focusPath`：在 module 行路径后接 `genPrefix.name` 段，且该段确实存在于树中时才用），webview 展开沿途、滚动到它并加 `.sel` 高亮（同一时刻只高亮一行）。无活动 module（非 HDL 编辑器）且未配置顶层时不动。显式命令（`revealInComposition`）仍可临时改根。**层次化显示 + 逐级展开/折叠**：每行带 `depth` 与 `parentPath`，webview 画出缩进与折叠三角（`▶`/`▼`），新建根时每一级默认折叠、点三角逐级展开到叶子；一个 module 的下级一次性全部列出（不分页，`defaultChildLimit` 只作用于连接图）。**搜索**：顶栏输入框按实例名 / module 名做子序列（fuzzy）匹配并高亮命中字母——与 Nets 视图同一套匹配；查询可含空格，按空白拆成多个词、**每个词各作子序列匹配、全部命中才算命中**（如 `u mid` 命中 `u_mid`）；搜索时只保留命中行及其**祖先**（路径可走），并强制展开这些行使命中可见，清空输入即恢复整棵树。点击行发 `{type:'open', path}` 让扩展在源码里定位；`revealInComposition` 先重定根再发 `{type:'revealPath', path}` 展开沿途并滚动到该行（不改变高亮）。节点图标：已解析 / 未解析（灰显 + ⚠）。**视图标题栏的全局展开/折叠按钮**：右侧的两个命令 `hdl.connectView.expandComposition`（`$(expand-all)`）/`collapseComposition`（`$(collapse-all)`）取代了原先的 Show Connectivity Graph 按钮（`showGraph` 命令本身仍在命令面板与行内右键菜单里）——点一次把整棵例化树全部展开或全部折回根部，webview 收 `{type:'setExpanded', expanded}` 后重绘（`expandAll` 清空 `collapsed`、`collapseAll` 把所有带子级的行重新折叠）。按钮图标随状态切换：webview 在状态变化时回传 `{type:'expandState', expanded}`（只在真正变化时发，避免每次光标移动都发），宿主 `setContext` 发布 `hdl.compositionExpanded` 上下文键，`view/title` 据此在 Expand all / Collapse all 之间二选一显示。**刷新索引带出新层次**：标题栏的 `refreshIndex` 在 `svc.refresh()` 重扫工作区后调 `CompositionViewProvider.refresh()`，后者**按缓存的根 module 名重新跑 `compositionHierarchy`**（`cachedRoot = compositionHierarchy(cachedRootModule, cachedFile)?.root`）再重建行——不能复用先前缓存的 `HierarchyNode`，否则那份旧的孩子列表会把新加的 module（及其整个子树）挡在树外；随后的 `syncEditor` 再定位/高亮当前 module。**模块过滤**：`hdl.connectView.composition.filterModules`（默认空）的每个条目先按索引里的 module 名判定（**名字优先**，保持原有按名配置不变）——命中则按**被例化的 module 名**过滤；否则当作路径：**文件**匹配该文件里定义的所有 module，**目录**匹配其下（递归）定义的所有 module，相对路径对**每个 workspace folder** 解析、绝对路径原样使用（与 `databasePaths` 的约定一致）。解析结果按配置数组的**引用**缓存（`refreshIndex` → `svc.refresh()` 重读配置后换新数组即失效），过滤时只看 module 的**定义文件**（`resolveModule(node.moduleName, node.file).file`），与它在哪个文件被例化无关。`composition.filterMode` 决定隐藏范围——**模式 1** 保留每个被过滤实例行本身、只砍掉它下面的子树（该行 `childCount` 置 0、当成叶子画，badge 追加 `filtered`，一眼看出是被过滤而非真叶子），**模式 2** 连实例行及其整棵子树一起隐藏；过滤在 `rebuild` 拍平行时就地判定（命中即不压子帧），`cachedRoot` 仍保留完整 `HierarchyNode` 树以免影响定位/`reveal`，配置变更经 `refreshIndex` → `svc.refresh()` 重读配置后再建。为命令/定位保留 `CompositionTreeProvider`（`modelFor`/`hierarchyRoot`）。**无限规模**：组合树的深度与实例都默认不限（`composition.maxDepth`/`maxInstances` = 0），因此整条链路都必须能扛住任意大——`Builder.expand` 改为**显式帧栈迭代**（且沿路径环检测用 `Set` 增删，不再每层 `[...pathModules, name]` 拷贝，深链从 O(depth²) 降到线性）、`findByPath`/`pathChain` 迭代且**按实例段逐段下走**（只比较下一段 + 段边界，不重扫整条前缀）、`CompViewProvider.rebuild` 的拍平走查同样迭代（子级逆序压栈保持父在前）、`locate` 的 BFS 用游标而非 `Array.shift()`（后者在每次光标移动时把 O(n) 的 BFS 拖成 O(n²)）、webview 的折叠可见性用**祖先栈一次线性扫描**（`hidden` 记当前折叠祖先数，被隐藏的行也压栈以维持祖先链），未改变的 `highlightPath` 直接跳过整树重绘；reveal 取根也走组合上限（不再被全局 `maxDepth`/`maxInstances` 截断）。被深度/预算截断或命中环的节点在 badge 上标注 `cycle`/`truncated`，不再看起来像叶子。`DESIGN.md` 记录 20000 深链与 30000 宽模块实测（深链 6 万节点 174ms、宽模块 10 万节点 191ms，均线性、不栈溢出）。**改为按需懒加载**：无限规模下若一上来就把整棵树建出、拍平、整包 `postMessage`，超大设计（实测 10 万节点 23MB、30 万节点 71MB、60 万直接 OOM；真实 `gpt2_tiny_top.v` 11119 节点 5.1MB）既卡又可能因消息过大而丢——于是把“先建满再发”换成“打开哪层才建哪层”。`HierarchyNode.children === undefined` 表示该层尚未材料化（叶子材料化后是 `[]`），eager 的 `buildHierarchy` 仍会把 `children` 填满，外部拿到的整树照旧可用；新增 `HierarchyBuilder.root`（建一个未材料化的根）、`childCount`（不材料化地预测直接子级，供行上画三角）、`expandLevel`（只材料化直接子级、子级保持未展开，尊重预算/深度/环并打 `truncated`/`cycle`）。`containingPath`（`containingDesign` 也改走它）不建树就给出设计顶层与到目标 module 的点号路径，宿主据此定根并沿路径逐层 `expandLevel`。宿主 `CompositionViewProvider` 缓存这棵懒树：`ensureRoot` 只按“根会变（换设计）”重建、每次 `setContext` 用 `containingPath` 定位后用 `materializeTo` 把到光标 module 的路径逐层材料化，把新展开的层级发 `{type:'children', parentPath, rows}`、再发 `{type:'highlightPath'}`；webview 维护 `loaded` 集合（某父行有子行即算加载），未加载层级点三角只发 `{type:'expand', path}`、收到 `children` 后把该层就地插到父行之后并展开（新子级默认折叠，仍逐级展开）；已加载层级在本地折叠。**Expand all** 改为宿主驱动（它才持有树）：`setExpandedAll(true)` 先按上限 `expandAll` 材料化再整包重发并通知 webview，`false` 仍在本地折叠。`refresh()` 重建懒根后**重新材料化先前的展开前沿**（`materializedPaths`/`rematerialize`），使新加的 module 出现而视图不塌陷。搜索只能覆盖已加载的行（按需加载后未打开的层级尚无行）；显式 `revealInComposition` 仍先建整树再交给 webview。实测：光标停在 4163 实例的 `datapath` 模块定义上，首次 `setContext` 5ms、3.6KB（只发到该 module 的路径、不展开它的 4163 个子级），同一设计内 20 次光标移动 2ms、仅高亮消息，而旧实现每次移动都要建满 11119 节点并整发 5.1MB。
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

### 5.4.1 层次显示方案（重设计：默认折叠 + 完整快速展开 + 打开即定位第一条分支）

§5.4 的"按需懒加载"解决了"不一次建整棵树"，但没有解决三件事：**同一 module 被多次例化时每层都重算一遍子行**、**反向查询（谁例化我）是全索引扫描**、以及**取根/定位用 BFS 最短链而非稳定可复现的分支**。本方案把显示拆成三层数据（事实 / 模板 / 实例行，见 §5.9），按下述规则渲染，逐条对应四条硬需求。

**根与默认折叠（需求 1：默认折叠、top 为根）**
- 根的解析确定化，自上而下取**真顶层**：
  1. `hdl.connectView.topModules` 非空 → 取其中第一个在索引里存在的名字；
  2. 否则 → 由当前 module 沿**第一条父边**（见下）上溯，直到第一个**没有父模块**（或回到已访问节点 = 环）的 module。与现行 `containingPath` 的"BFS 最近顶层 / 最短链"不同：**真顶层**才作根，避免 testbench 等较浅的父把根抢走；链固定为第一条分支，使根**稳定、可复现**；
  3. 无活动 HDL module 且未配置顶层 → 不建树（同现行）。
- 新建 / 换根后**每一级默认折叠**，只发根行；点三角逐级展开。

**第一条分支（确定性排序）**
- 一条**父边** = 某 module 里一条指向目标 module 的 `InstanceSite`。
- 排序键：`(父文件绝对路径, inst.nameRange.start.line, inst.nameRange.start.character, inst.rawName)` 字典序。
- **第一条分支** = 从目标 module 出发，每层取排序最小的父边，上溯到根；`visited` 防环（环里回到已访问节点即停）。路径自顶向下拼出，每段 `genPrefix ? genPrefix + '.' + name : name`。
- 需求 1 的"真顶层"与需求 3 的"定位分支"共用这条链，因此"打开文件定位到的 module"与"树里可见的那条分支"永远是同一条。

**展开一层：完整且快（需求 2：快速列出下一级全部例化，不遗漏）**
- **完整**：直接取 `childIndex[moduleName]`（§5.9），它是该 module `ModuleDef.instances` 的预编译视图。parser 已把 generate `for`/`if`/`case` 展开成逐条 `InstanceSite`（`MAX_GENERATE_UNROLL = 64` 仅截断病态巨循环，是已声明上限），所以"下一级所有例化的模块"天然齐全——**不分页、不丢行、不因预算静默截断**（`composition.maxInstances` 默认 `0` = 不限；显式设定才截断并带 `truncated` 标记）。
- **快**：
  1. **模板复用**：把每个 module 的 `instances` 编成不含路径的 `RowTemplate[]`（`instName`/`rawName`/`moduleName`/`resolved`/`hasChildren`/`file`/`nameRange`/`moduleNameRange`/`range`/`genPrefix`/`conditional`），按 module 记忆化。同一 module 被例化 N 次时，N 次展开复用同一份模板，只加 `path` 前缀——消除现行 `expandLevel` 每行重跑 `resolveModule` + 每行两次 `directCount` 的开销。
  2. **行构造 = 前缀映射**：`rows = template.map(t => row(prefixPath, t))`，无二次解析。
  3. **超大层分片投递**：一层行数超过内部阈值（默认 2000）时按固定批量 `postMessage` 追加（`rowsChunk`），webview 逐批渲染；**行数一条不少**——分片只为不阻塞消息循环与首帧，不是分页，界面不出现 `more`（`defaultChildLimit` 仍只作用于连接图）。
  4. 沿用 `HierarchyBuilder` 的懒展开骨架（`root` 初建即 `children === undefined`、`childCount` 预判三角），`childCount` 直接取 `childIndex[child].length`，不再现算。

**打开文件：定位第一条分支并完整显示该分支（需求 3）**
1. 取活动文件里光标所在 module（`moduleAtLine` 的判定；光标不在任一 module 体内时取该文件**定义顺序第一个** module）。
2. `M = index.resolveModule(name, file)`。若当前根已是同一设计顶层且 M 在树里，复用现有树，仅更新高亮（沿用"树不搬家"）。
3. 用 `entryIndex`（§5.9）取 M 的入口链 `{top, path}`——由 `parentIndex` 逐层取第一条父边得到，**O(深度 × 父边数)**，不再像现行 `containingPath` 那样每次 `instantiatorsOf` 全索引扫描。
4. 根设为 `top`，沿 `path` 逐级用 `childOnPath` 展开：每一级都材料化该层并把路径上的那一条子行展开，其余兄弟行**照样发出但保持折叠**。"完整显示整棵树的分支" = 从根到 M 的**每一级**都展开可见、兄弟折叠待展开，而不是只把 M 一行塞进去。
5. `highlightPath = path`，滚动并加 `.sel`（同一时刻只高亮一行）。
6. 被多处例化时（M 有多条父边，或同一父 module 多次例化 M）**取第一条分支**，不弹列表：组成树是"定位"（要稳定、可复现），与 trace 的"跳转"（多目标弹 `QuickPick`）语义不同。
- 换到另一顶层（另一份设计）时重建根到 M 的第一分支顶层；进行中的展开 / 折叠状态丢弃（同现行"换设计才重建"）。
- 打开/切换文件定位时，`highlightPath` 附带 `collapseOthers: true`：webview 先折叠所有带子级的分支，再展开并高亮目标路径，树里只留这一条分支展开；同一文件内移动光标、活动编辑器不是 HDL 文件（`undefined`）时不带该标记，读者手动展开的分支保持原样。显式定位命令走 `revealPath`，同样不折叠。

**性能目标（对应 §7）**：展开一层 = O(该层子数)；打开文件定位 = O(深度)；两者都不随工作区实例总数增长。

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
    // Auto-generated by rtlens
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

### 5.6 分类数据库（`.vscode/rtlens/`）

把设计的事实固化成一组可落盘、可 diff 的 JSON，按**职责分类**放在每个工作区目录的 `.vscode/rtlens/` 下（多根工作区每个目录一份，随目录树走，互不干扰）：

| 文件 | 职责 | 读者 | 生命周期 |
|------|------|------|----------|
| `index.json` | 模块定义（kind/位置/端口/参数/声明/引用计数）+ 例化边，键为目录相对文件 | 无（**artifact**：可检视 / 可 diff，不改 `HdlIndex`） | 落盘 |
| `hierarchy/current.json` + `hierarchy/g-*/m/NNN.json` | 例化**图**分片（v3：manifest 记 generation/tops/counts，256 个按 module 名哈希的分片各存 `children`/`df`/`cc`） | 组成树（`CompositionStore` 按需读分片；无库且索引已就绪时回退内存） | 落盘；保留最近 2 个 generation |
| `graph.json` | 每个顶层的**默认**连通图（`buildGraph` 产物） | 无（**artifact**：连接图全交互，每次点击都换深度/折叠/分页重取） | 落盘 |
| `relations.json` | 信号读写 + 端口连线 | 无（状态栏统计；§5.6 下半节） | 落盘 |

**激活不扫描、也不预读层次库**：`activate` 只挂 provider 与事件，首次 definition/hover/nets/graph 等请求或索引第一次 ready 后才建索引；层次库的读取再延后到索引 ready（`CatalogService.load()` 只读 manifest 并校验指纹）。写盘来自显式刷新，或 `hdl.connectView.autoUpdateDatabase`（默认开）下的自动增量刷新。三个新库由一个 `CatalogService` 统一管理（`src/vscode/catalog.ts`，纯核心模型在 `src/core/indexDb.ts` / `hierarchyStore.ts` / `hierarchyDb.ts` / `graphDb.ts`），`relations.json` 仍归 `DatabaseService`（`src/vscode/database.ts`）；两者共享状态栏刷新命令与 `scheduleAutoRefresh` 节奏（状态栏只保留一个按钮，tooltip 提及四个文件）。

**启动阻塞（本轮修复）**：VS Code 会为每个恢复的编辑器请求 Document Symbols。该 provider 若 `await svc.ensureReady()`，打开窗口就等于触发全工作区扫描——同步解析压在共享的扩展宿主上，会推迟本扩展和其他所有扩展的激活。现在大纲只 `parseSource(document)` 当前缓冲区，不碰索引；`workspaceContains:**/*.v` / `**/*.sv` 也删掉了（改为仅 `onLanguage`，视图/命令由 VS Code 1.74+ 的隐式激活事件兜底），避免启动时先搜索整个工作区；首次 composition 同步用 `setTimeout(0)` 让出激活 tick；`CompositionViewProvider.followEditor()` 在视图不可见时只记住当前文件/光标，不解析活动缓冲区（大文件单次解析可达秒级），等 webview 可见或发出 `ready` 时才解析并定位。状态栏/命令触发的数据库刷新也会在 index / hierarchy / 每个顶层 graph 之间 `setImmediate` 让出事件循环，避免长时间占住扩展宿主。`startup.test.ts` 把 `findFiles` 桩成抛错并断言请求大纲后日志里没有 `[index]` 扫描行，同时断言 manifest 不含 `workspaceContains:`；`views.test.ts` 另有一例把活动文档的 `getText` 换成计数器，确认隐藏的组成视图只记上下文、不读缓冲区。

- **新鲜度（source 指纹）**：每个库都记一个 `source` 字段 = 构建它时源文件集合的指纹（`sourceFingerprint(files)`，`src/core/relations.ts`：按 `rel:hash` 排序后哈希，与目录位置无关）。特性只在指纹与当前工作区一致时才读文件，否则回退内存索引——因此库是纯加速 / 可检视产物，永不影响正确性。
- **组成树读回**：v3 把层次库拆成 `hierarchy/current.json`（manifest，最后原子写）+ `g-<generation>/m/<shard>.json`（256 个分片，FNV-1a 按 module 名定位；记录去掉了反向边 `parents`，边上的 `df`/`cc` 给出子模块定义文件与子节点数）。`CompositionStore.open(folder)` 读 manifest 并校验 `version`/generation 路径，`module(name)` 只读该 module 所在分片（LRU 64）；DB 侧的 `CompositionSource` 按需展开一层，因此组成树首屏只加载根及其直接子级，点开一层才读下一层分片。manifest 的 generation 在打开时钉住，重建换 generation 后由 `CatalogService.onDidChangeDatabase` 触发 `composition.refresh()`（找不到根时保留旧树，避免重建瞬时态清空视图）。无库且索引已就绪时回退 `buildHierarchyDatabase` 的内存源，`df`/`cc` 与落盘记录含义一致。
- **`index.json` / `graph.json` 是 artifact**：写盘只为把设计的词汇表（有哪些 module、怎么连）落成可评审文件，**不接线回读**——激活仍解析源码建 `HdlIndex`（§2.1「索引不落盘」不变），连接图每次都按交互参数重取。

#### 5.6 下半：信号 / module 关系数据库（`relations.json`）

把“哪个 module 有哪些信号、谁读谁写、实例把哪个信号接到了子模块的哪个端口”固化成一份可落盘、可 diff 的 JSON，即上表的 `.vscode/rtlens/relations.json`。写盘来自显式刷新，或 `hdl.connectView.autoUpdateDatabase`（默认开）下的自动增量刷新。

- **纯核心** `src/core/relations.ts`（不碰 `vscode`/`fs`/时钟）：`moduleRelations(index, mod)` 复用 `signalUsage`（信号读写者）与 `inst.connections` + 子模块端口方向（module→module 连线）；`fileRelations` 按文件聚合并按 module 名排序；`hashText` 是自研的双 32 位混合哈希（长度入哈希），只为回答“这个文件相对上次刷新变了没”，因此不引入 `crypto`；`updateDatabase(index, existing, inputs, mode, ts)` 是纯函数，`serializeDatabase`/`parseDatabase` 做紧凑 JSON 与版本校验（`version` 不符即丢弃，宁可重建）。
- **宿主层** `src/vscode/database.ts`：解析路径、**经 `vscode.workspace.fs` 异步读写**（读盘不再用 `fs.readFileSync`，同步阻塞会让状态栏点击的命令 RPC 排在整次读盘之后——"build DB 点不动"的根因）、`collectInputs` 取该目录下已索引文件（键为目录相对路径 + 内容哈希，哈希取 `indexedText`，即索引里的文本，不重读盘）、状态栏按钮与 `QuickPick`。
- **刷新语义**：
  - **全量**：忽略旧库，逐文件重算。
  - **增量**：内容哈希未变的文件复用旧记录；哈希变了的文件重算；不再被索引的文件从库里删除；**并且**重算那些“实例化了本次变化文件里定义的 module”的文件——父模块的端口方向标签来自子模块定义，只改子文件时若只按父文件哈希判断，方向就会过期。
- **自动更新**（`hdl.connectView.autoUpdateDatabase`，默认 `true`）：`DatabaseService` 订阅 `IndexService.onDidChange`，文件改动后触发**防抖的增量刷新**（默认 500ms，把一次保存引发的一串索引事件并成一次写盘），并且**不与自己或手动刷新重叠**（重入时记 `pending`，跑完再补一次）。两个门槛：其一 `autoStarted` 只在 `load()` 之后才置位，因此**激活扫描发出的同款索引事件不会触发写盘**（`load()` 本身也只读不写）；其二订阅时检查 `svc.config.autoUpdateDatabase`，关闭时文件改动不改库。**关掉不等于死库**：`files`/`includeDirs`/`exclude`/`databasePaths`/`databasePathsOnly` 这些**决定文件集合**的设置一改，扩展在重扫索引后仍会强制排一次刷新（`scheduleAutoRefresh(0)`，不看开关）——文件集合动了库就必须跟着动。
- **交互**：状态栏（下方条）一个 `$(database) RTLens DB` 按钮，命令 `HDL: Refresh Signal/Module Database`，点击弹 `QuickPick` 选“增量刷新 / 全量重建”；按钮 tooltip 汇总文件/模块/信号/连线数，未建库时显示 `RTLens: build DB`。刷新用 `withProgress` 显示进度，结束用状态栏消息报告 `recomputed / reused / removed`；按钮自身在第一个 `await` 之前同步转成 `$(sync~spin)`（点击立刻有反馈），跑完或抛错都经 `finally` 落回静止标签，且每个工作区文件夹之间 `setImmediate` 让出一次事件循环——长刷新不再饿死宿主消息循环（进度也才有机会重绘）。
- **变异校验**（`database.test.ts`）：去掉 `onIndexChange` 里的 `autoStarted` 门槛（激活扫描的事件也会写盘，“activation scan alone”一例转红）、去掉 `autoUpdateDatabase` 门槛（关闭时仍写盘，“disabled”一例转红）——两处都会被抓住。这两处用例的否定断言都**等满防抖（> 500ms）**才断言，否则删除门槛后、定时器尚未触发时断言也会通过，等于没测。

### 5.7 信号 / 模块追踪（层次逐跳）

光标放在信号/端口或模块/实例名上，`HDL: Trace Up`（`F3`）向顶层走、`HDL: Trace Down`（`F4`）向叶子走。**每次只跨一跳**，不是传递闭包：跳到落点后可以从那里继续追，连按即可走到顶/到底，`up`/`down` 的语义始终明确。入口 `traceAt` 用一次 `resolveAt` 判定光标内容并自动分派：`module`/`instance` → 模块追踪，`port`/`signal`（及其它可连线符号）→ 信号追踪。

- **信号——向上（`F3`，朝顶层）**：
  1. 光标在信号的**使用处** → 落到本模块内它的**声明处**；
  2. 光标在**端口声明处** → 通过 `instancesOf` 找到例化本模块的父实例，落到该端口的父侧连接网；重复直到顶层。
- **信号——向下（`F4`，朝叶子，分两步）**：
  1. 光标在信号上 → 落到本模块内**连着该信号的子实例连接处**（仍在当前模块，即 `inst.connections` 里父侧引用命中该信号者）；
  2. 光标在该连接处 → 进入**子模块的端口声明**；重复直到叶子；
  3. **最底层**：光标在叶子端口（或任何没有子实例连着的信号）上时，再按 `F4` 落到**本模块体里该信号被使用的位置**（`assign`/`always` 的两侧、事件/条件/`generate` 引用），`kind` 为 `usage`。此时已到底，无更深的层次可走。
- **模块——向上（`F3`）**：以光标所在的**包含模块**为锚点，`instancesOf(index, mod.name)` 找到所有例化它的父实例，落到父文件里该实例的名字处（`kind: 'parent-instance'`）；这份工程里被多处例化就弹列表选一个，可继续从落点再按向上逐级走到顶层模块。顶层模块无人例化时无目标。
- **模块——向下（`F4`）**：遍历 `mod.instances`，对每个例化的模块名 `index.resolveModule(inst.moduleName, mod.file)` 取回子模块定义，落到**子模块实现文件**里它的 `nameRange`（`kind: 'child-module'`）；解析不到的例化（外部库/未索引）跳过。当前模块例化多个子模块时弹列表。光标落在实例名（`kind: 'instance'`）或模块类型名/定义名（`kind: 'module'`）上都能触发，锚点都是包含模块。
- **纯核心** `src/core/trace.ts`（不碰 `vscode`）：`traceAt` 先 `resolveAt` 一次，`module`/`instance` 走 `moduleTrace`，否则把已解析的 `hit` 交给 `signalFromHit`（`traceSignal` 也复用它，保持既有单测入口）。信号追踪只接受 `port`/`signal` 两种 kind。连接处的端口名（`.wdata`）在父模块作用域里解析不到，直接按模块内的连接范围（`conn.nameRange`/`conn.range`）定位；`u_adder.sum` 这类层次引用则按点分路径找到实例与连接，落到连接处。解析时名字前的 packed range（`wire [7:0] name`）不并入点号路径——否则端口名会拼成 `wire.name` 而解析失败，带位宽的总线端口就追不动。连接处按 `F3` 会落回它携带的父侧网。
- **方向归一**：与 Net 视图一致，用 `generateScopes`/`generateScopedName` 把 `g[0].t` 与 `t` 归并到同一信号；按 file:line:char 去重，展开的 generate 副本折叠成一跳。
- **宿主层** `src/extension.ts`：`syncOpenDocuments()` 后调用 `traceAt`（一次解析、自动分派），单一目标直接 `revealLocation` 跳转，多个目标 `QuickPick` 让用户选择（不静默挑一个），无目标时提示“nothing above / nothing below”；标题为“up from / down from `name`”，无可追踪符号时提示光标放到信号/端口/模块/实例上。
- **测试** `src/test/trace.test.ts`（24 例，纯核心）：信号部分——使用处→声明处、端口声明→父实例连接网、output 端口同样跨到父实例、带 packed range 的总线端口声明（`output wire [7:0] q`）同样跨到父实例、顶层端口无上层、非端口声明无处可去、信号→子实例连接处、连接处→子端口声明、连接处的父侧网、最底层时信号→模块体内的使用处（无子连接的信号落到 `assign` 的读引用、叶子端口落到驱动它的 `assign`、只用条件门控的信号落到该条件引用）、层次引用 `u1.o` 进子端口/退回父网、未解析光标与 module 名返回 `undefined`、generate 副本按位置去重；模块部分——模块定义名向上到父实例（`datapath`→`chip_top` 的 `u_dpath`）、实例名向上同样从包含模块起跳（`u_adder`→`u_dpath`）、模块向下到子实现（`datapath`→`adder.v`/`regfile.v`）、顶层向上无父、`chip_top` 向下扇出到 `control.v`/`datapath.v`、光标在信号上不是模块追踪、`traceAt` 按光标内容分派；以及基于 `test/fixtures/lib` 的真实跨文件追踪（`datapath.alu_sum` 向下到 `u_adder.sum` 与 `u_regfile.wdata` 两个连接处、连接处再进 `regfile.wdata`；`datapath.carry` 向上跨到 `chip_top` 的 `u_dpath.carry`）。做过变异校验：忽略“使用处→声明处”、把层次引用当成本地信号、信号不再匹配子连接、去掉目标去重、子端口落到父文件、端口跨层忽略父侧引用、层次引用认错实例、`expandChain` 左走 `]` 时不检查 `[` 前是不是真实链步（带 packed range 的声明 `wire [7:0] name` 又拼成 `wire.name`）、去掉最底层的使用处回退（`targets.length === 0` 恒假）、使用处不再扫事件/条件/`generate` 引用——十处都会被 `trace.test.ts` 或 `resolve.test.ts` 抓住。本轮模块追踪又做三处：向下的子实现写成父文件（`child.file`→`mod.file`）、向上按错误的模块名搜索（`mod.name` 改名）、`traceAt` 只分派 `instance` 不分派 `module`（模块定义名不再走模块追踪）——三处都会被抓住。

### 5.8 全局模糊搜索 module 并跳转（复用系统 `#` 输入框）

不新增输入框：把全工作区的 module 定义接进 VS Code 原生的「Go to Symbol in Workspace」输入框（Quick Open 里前缀 `#`，键盘 `Ctrl+T`/mac `Cmd+T`，命令 `workbench.action.showAllSymbols`），按名字或文件路径模糊过滤，确定后打开实现文件并把光标落在 module 名上。扩展只贡献一个 `WorkspaceSymbolProvider`；`Ctrl+T` 不再被 `package.json` 的快捷键覆盖（旧版在 HDL 编辑器里用自己的 quick pick 抢占 `Ctrl+T`，现移除该绑定），因此各语言行为一致。命令 `HDL: Go to Module`（`hdl.connectView.goToModule`）与编辑器右键菜单保留，但内部改为 `executeCommand('workbench.action.showAllSymbols')`——即同一个系统框。

- **列表** `HdlWorkspaceSymbolProvider.provideWorkspaceSymbols()`（`src/vscode/providers.ts`）：`index.allModules()`（每个**定义**一条 `SymbolInformation`，不按名字合并——同名两处定义如 RTL 与黑盒 stub 要靠路径区分）→ 按 `name` 再按 `file` 排序 → `name: name`、`kind: moduleSymbolKind(kind)`（module/program/primitive→`Module`、interface→`Interface`、package→`Namespace`、class→`Class`）、`containerName: kind`、`location: locationOf(file, nameRange)`（落点就是 `nameRange`，打开即光标在名字上）。`moduleSymbolKind()` 同时被文档符号 provider 复用（module 的轮廓图标因此统一为 `Module`）。
- **模糊** 由 provider 自己按 `query` 过滤：空格分词、逐词在「module 名」或「相对路径」上做大小写不敏感的子序列匹配（与组合树/Nets 的 fuzzy 同款语义），全部命中才保留；返回后 VS Code 再做自身的高亮与排序。空查询返回全部。
- **宿主层** `src/extension.ts` 注册 `vscode.languages.registerWorkspaceSymbolProvider(new HdlWorkspaceSymbolProvider(svc))`；provider 以 `await svc.ensureReady()` 开头，保证索引就绪后再列（与其它读索引的 provider 一致）。
- **测试** `src/test/providers.test.ts` 经 `vscodeStub`（新加 `SymbolInformation` 假类、`registerWorkspaceSymbolProvider`、`provider('workspaceSymbols')` 访问器）激活真实扩展，断言：空查询列出各来源模块（`lib/` 与根目录 fixtures）且按名排序、用只出现在路径里的词（`legacy` → `fifo`）能命中、无匹配查询清空、选中 `adder` 的 `location` 指向 `lib/adder.v` 且行/列落在 `module adder` 的名字上；另有一例断言 `hdl.connectView.goToModule` 确实转发了 `workbench.action.showAllSymbols`。变异校验：`subsequence` 恒真（过滤失效，`zzz_nope` 不再清空）、落点用 `def.range` 而非 `def.nameRange`（字符位由 7 变 0）、命令改成空实现（不转发系统命令）——三处都会被 `providers.test.ts` 抓住；不注册 provider 或删掉过滤变量则被 `noUnusedLocals` 编译守卫挡下。

### 5.9 数据库分层与层次显示库（Hierarchy DB）

现状只有一个内存索引 `HdlIndex` 加一个落盘关系库 `relations.json`，而"谁例化谁"的反向查询（`HdlIndex.instantiatorsOf`、`resolve.ts` 的 `instancesOf`）都是**全表扫描**——遍历 `byFile` 下每个 module 的每条 `instances`，复杂度 O(工作区实例总数 E)。这是大工作区里"打开文件定位很慢 / 展开卡"的根因，也是需求 4 要重设计的部分。新方案按**职责**把数据分层，并单列一个层次显示专用库。

**数据库目录（catalog）**

| 库 | 职责 | 关键结构 | 更新方式 | 位置 / 生命周期 |
|---|---|---|---|---|
| **定义库** Definition DB | 名字↔定义、文件↔模块、行→模块 | `byName: Map<name, ModuleDef[]>`、`byFile: Map<file, ModuleDef[]>` | `addFile`/`removeFile` 就地改 | 内存（`HdlIndex`），随索引 |
| **实例边库** Instance-Edge DB | 正向 module→例化谁；**反向 module→谁例化它** | `childIndex: Map<module, ChildDesc[]>`、`parentIndex: Map<module, ParentRef[]>` | **增量**：增删文件只改该文件产生的边 | 内存，随索引 |
| **层次显示库** Hierarchy DB | 渲染一层所需的行模板 + 打开文件的入口链 | `levelTemplate(module): RowTemplate[]`、`entryIndex: Map<module, Entry>`；持久化形态为 `hierarchy/`（v3 manifest + 哈希分片，§5.6） | 由前两库派生，按 `epoch` 失效；持久化形态按 `source` 指纹失效 | 内存按需建 / LRU；另可落盘 `.vscode/rtlens/hierarchy/`（`current.json` + `g-*/m/NNN.json`） |
| **跳转关系库** Jump DB | 光标→声明 | 每文件跳转表 | 增量，随内容哈希 | 内存 LRU |
| **信号关系库** Relation DB | 信号读写、端口连线 | `relations.json` | 增量 / 全量落盘 | **持久化** `.vscode/rtlens/relations.json`（§5.6） |

分类原则：**原始事实 / 派生缓存 / 持久化**三者分开。
- 前两个新库里，`childIndex`/`parentIndex` 是**原始事实**（由 IR 直接得出，权威）；`levelTemplate`/`entryIndex` 是**派生缓存**（可随时从原始事实重算）。二者必须分开——缓存失效只影响速度，绝不影响正确性（测试断言"清空缓存后结果不变"）。
- **落盘**：除上表的 `relations.json` 外，本轮又新增**分类数据库**（`index.json` / `hierarchy/` / `graph.json`，见 §5.6）——其中 `hierarchy/` 是上表「层次显示库」的**持久化形态**（v3：`current.json` manifest + 256 个按 module 名哈希的分片），`index.json` / `graph.json` 是 artifact（可检视，不回读）。落盘库都带 `source` 指纹：只在新鲜时被读（组成树经 `CompositionStore` 按需读分片），否则回退内存。
- **留内存**：`HdlIndex` 的定义库、实例边库（`parentsOf` 反向边）、`HierarchyBuilder` 的惰性行模板——它们是索引派生物，沿用 §2.1 的"索引不落盘"决策，留内存、随索引失效即可。

**实例边库（原始事实）**

```ts
/** module X 被谁例化（反向边）。 */
interface ParentRef {
  parentModule: string;   // 父 module 名
  file: string;           // 父 module 所在文件（定位用）
  inst: InstanceSite;     // 那条例化（含 name / genPrefix / nameRange / range）
}
/** module X 例化了谁（正向边的预编译视图）。 */
interface ChildDesc {
  instName: string;       // genPrefix ? genPrefix + '.' + name : name
  rawName: string;
  moduleName: string;
  nameRange: Range; moduleNameRange: Range; range: Range;
  genPrefix?: string; conditional?: boolean; arrayCount?: ValueRange;
  file: string;           // 父 module 所在文件
}
// HdlIndex 新增：
childIndexOf(name: string): ChildDesc[]    // def.instances 的预编译视图
parentsOf(name: string): ParentRef[]       // 反向边，O(父边数) 取回
```

- `addFile`：解析后对每个 module `m`、每条 `inst`，重建 `childIndex[m.name]`，并向 `parentIndex[inst.moduleName]` 追加 `{parentModule: m.name, file: m.file, inst}`。
- `removeFile`：按 `file` 反查（维护 `file → ParentRef[]` 的辅助表）删除该文件贡献的全部反向边，并删掉 `childIndex` 里该文件的 module。
- **`epoch`**：每次 `addFile`/`removeFile` 递增（可复用现有的索引代数计数）；`levelTemplate`/`entryIndex` 带 `epoch`，不匹配即惰性重算。
- 复杂度：建库 O(E) 一次（索引本来就要遍历 `instances`，边际成本近似为零）；此后每次反向查询从 O(E) 降到 O(该 module 的父边数)。光标移动路径（`containingPath`/`focusPath`）与 trace 的两处 `instancesOf` 全部受益。
- 取代：`HdlIndex.instantiatorsOf` 改为 `parentsOf` 的薄包装并**弃用全表扫描**；`resolve.ts` 的 `instancesOf` 改为 `parentsOf(name).map(p => ({ mod: defOf(p.file, p.parentModule), inst: p.inst }))`。

**层次显示库（派生缓存）——需求 4 的专用库**

三层，按"事实 → 模板 → 实例行"分：

1. **事实层** = 实例边库的 `childIndex`/`parentIndex`（完整、权威）。
2. **模板层** `levelTemplate(moduleName): RowTemplate[]`：
   - 把 `childIndex` 每条 `ChildDesc` 编成**不含路径**的行模板：`instName`/`rawName`/`moduleName`/`file`/`nameRange`/`moduleNameRange`/`range`/`genPrefix`/`conditional`，并预算 `resolved = 定义库无此 moduleName`、`hasChildren = childIndexOf(moduleName).length > 0`。
   - `resolved`/`hasChildren` 依赖定义库，因此模板随 `epoch` 失效（新定义一个 module 会让原先 unresolved 的实例变成 resolved）。
   - 按 module 记忆化。这是"展开一层快"的核心：同一 module 例化 N 次只编一次模板。
3. **实例层**（视图侧）：模板 + `path`/`parentPath`/`depth` 前缀即得行；由 `HierarchyBuilder` 的节点缓存持有。`entryIndex` 缓存"M 的第一分支入口链"，供需求 3 的 O(深度) 定位。

```ts
interface Entry { top: string; path: string; segs: { parent: string; inst: InstanceSite }[] }
entryOf(name: string): Entry | undefined   // 用 parentsOf 每层取排序最小的父边（§5.4.1）
```

**为什么这个专库能满足"快速显示"**
- 展开一层 = `levelTemplate(M)` + 前缀映射 = O(该层子数)，无解析、无全表扫描。
- 打开文件定位 = `entryOf(M)`（O(深度 × 父边数)）+ 沿路径 `childOnPath` 逐级 = O(深度)。
- 大数据量 = 模板复用（同 module 重复例化零额外编译）+ 超大层分片投递（§5.4.1）。
- 完整 = 直接来自 `def.instances`，generate 逐条展开的实例都在，不遗漏。

**失效与一致性**
- **内容变**（文件增 / 删 / 改）：`epoch++`；`childIndex`/`parentIndex` 就地增量更新；`levelTemplate`/`entryIndex` 惰性重算。
- **配置变**（`topModules`/`filterModules`/`filterMode`/`composition.max*`）：不动库，只影响视图的取根与过滤。
- 缓存永不影响正确性：任一缓存丢失都可由事实层重算。

**测试（已实现，扩充 `index.test.ts` / `hierarchy.test.ts` / `compview.test.ts`）**
- 边库：`parentsOf` 返回全部父边且含 `file`/`inst`；`addFile`/`removeFile` 后正向 / 反向边精确增删（无残留、幂等，重复 `removeFile` 同一结果）。
- 第一条分支：多条父边按 `(file, line, char)` 取最小；环内终止；`entryOf` 的 `top` 与"真顶层"一致，路径逐段拼法与 `childOnPath` 对得上。
- 展开完整：generate 展开的 N 个实例全部出现在一层里（不丢），`childCount` 与 `levelTemplate().length` 一致。
- 模板复用：同一 module 两次展开得到相同模板（深等）。
- 打开定位：给定文件 → `entryOf` 链 → 逐级 `childOnPath` 命中 M 且路径每一级都在树中。
- 失效：`epoch` 变更后重算的模板 / 入口与冷算一致；清空缓存后结果不变。
- 分片：超大层分片投递的行数之和 == 该层总行数，顺序稳定。

**与现有实现的差异（同步 §11.2）**
- `instantiatorsOf` / `instancesOf` 的全表扫描 → 增量 `parentIndex`（O(E) → O(父边数)）。
- `expandLevel` 每行 `resolveModule` + 两次 `directCount` → 模板复用。
- `containingPath` 的"BFS 最近顶层 / 最短链" → "第一条分支的真顶层"（语义变化：根更稳定，个别多父场景下选根可能与现行不同）。

---

## 6. 配置项

```jsonc
{
  "hdl.connectView.files": ["**/*.{v,sv,svh,vh,vlt}"],      // 纳入索引的 glob（多个模式会拼成 `{a,b}`）
  "hdl.connectView.includeDirs": ["include", "../common"], // `include 搜索目录
  "hdl.connectView.exclude": ["**/tb/**", "**/*_tb.v"],     // 排除（默认含 tb）
  "hdl.connectView.topModules": [],                          // 手动指定顶层（组成树以之为根），空则自动推断并从当前 module 定根
  "hdl.connectView.maxDepth": 32,                            // 层次展开深度上限（图/生成器等全局层次用）
  "hdl.connectView.maxInstances": 20000,                     // 实例总数上限（防爆）
  "hdl.connectView.composition.maxDepth": 0,                 // 组合树（左侧层次）自己的深度上限；0 = 不限（环检测仍拦自例化）
  "hdl.connectView.composition.maxInstances": 0,             // 组合树自己的实例行上限；0 = 不限
  "hdl.connectView.composition.filterModules": [],           // 组合树要过滤掉的条目：module 名 / 文件路径 / 目录路径（名字优先；相对路径按 workspace folder 解析）
  "hdl.connectView.composition.filterMode": 1,               // 1 = 保留被过滤实例但隐藏其子模块（当作叶子）；2 = 连同实例及整棵子树一起隐藏
  "hdl.connectView.graph.maxNodes": 800,                     // 图渲染上限
  "hdl.connectView.graph.showContainment": false,            // 图中默认不画层次包含边
  "hdl.connectView.graph.maxSignalsPerGroup": 40,            // 每框信号行上限（core 侧硬裁剪：先物化实例端口连线、再 assign 两端、最后端口声明；上限用尽后不再画连不上线的子框，其余收进 `...` 分页可点开；0 = 不限）
  "hdl.connectView.defaultChildLimit": 40,                    // 连接图每页带出的下级子框数（框内一行 `more children`，每点补一页并放行一页节点预算）；组合树不分页
  "hdl.connectView.enableSemanticHighlighting": true,        // 关闭后由 TextMate grammar 单独着色
  "hdl.connectView.followDefinition": true,                  // F12 跳到 module 而非层次树
  "hdl.connectView.databasePaths": [],                       // 额外纳入索引/关系数据库的目录或文件
  "hdl.connectView.databasePathsOnly": false,                // true = 只扫 databasePaths，不扫工作区
  "hdl.connectView.autoUpdateDatabase": true,                // 文件改动时自动增量更新关系数据库；关闭后仅在命令或文件集合变更时刷新
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
| 400 module × 100 signal / 20 文件 | 387ms | 17.7ms（f0：20 module） | 385ns | 240ns | 46ns |
| 2000 module × 200 signal / 50 文件 | 4.2s | 46.3ms（f0：40 module） | 510ns | 271ns | 49ns |

索引耗时由扫描期的 parse 主导（后台进度条，与光标无关）；跳转只有**首次**查询付建表成本，之后三个热路径都是常数级，与工作区规模无关。

**大文件热路径**（`test/gpt2_tiny_top.v`，6MB / 98 module / 7895 instance）：

| 操作 | 优化前 | 优化后 | 手段 |
|------|--------|--------|------|
| `HdlIndex.addFile`（解析+索引） | 1712ms | ~1.1s | 词法器按字符码扫描、`skipWhile` 不建字符串 |
| `buildFileJumps`（关系表建表） | 858–1381ms | ~0.52s | 同上；每行只查一次 `moduleAtLine` |
| 关系图（depth 8 / 50000 节点） | 1145ms | ~450ms | `findInstance`/端口表/参数作用域按 module 记忆化 |

词法器（`core/lexer.ts`）是索引与建表共同的瓶颈：它过去对每个字符都调一次 `advance()` 并 `out += ch` 拼字符串、谓词用正则。现在 `advance`/`skipWhile` 只推进下标并维护 line/col，原始文本在每个 token 处 `slice` 一次；字符分类（空白、标识符、数字）改用整数码比较。词法结果是逐字节等价的（同一文件 token 数与 range 哈希不变）。`graph.ts`/`hierarchy.ts` 的端口、实例名、参数作用域都按 `ModuleDef` 用 `WeakMap` 缓存，模块级对象不变则不再线性重扫。

---

## 8. 测试策略

1. **单元测试（Node，无 vscode 依赖）**，`src/test/*.test.ts` 编译到 `out/test/` 后由 `node --test` 运行：

   | 套件 | 覆盖 | 用例数 |
   |------|------|--------|
   | `parser.test.ts` | 词法（数字/注释/属性/指令）、关键字表与 parser 分发一致、ANSI 与非 ANSI 端口、`ref` 方向、隐式 `.name` 与 `.*`、generate 展开、defparam、缺 `endmodule` 恢复、macroRef、function/task、过程赋值、层次引用、typedef 声明（三种写法与 package 内）、以 typedef 名声明的变量（标量/数组/初始化）、**文件作用域 typedef**、**package 限定类型 `p::t x;`**、**类型在本文件不可见的声明仍保留**、**无端口列表的实例化 `sub u;`**、事件控制中的信号、门级运算符不产生引用、**`bind` 语句记录被绑定的实例**（`bind`/`let` 曾被当成 block 整条丢弃）、**连续赋值产生的隐式 net**、模块体内的 `import` 语句、**enum 成员是所在作用域的常量**（`{A=2'b00, B, C}` → `A=0/B=1/C=2`，成员值里引用别的成员也算引用）、**文件作用域 enum 的成员要跟着类型一起下发**、模块自己的同名 parameter 遮蔽共享下来的成员、**package 里的 enum 成员**、**generate 块里的 `assign`/`always`/`initial`/`defparam`/`bind`**（该循环过去只认声明、参数、类型和实例）、**generate `if/else` 的 else 分支**、**命名过程块 `begin : name` / `fork : name`**、**块内局部声明**（关键字类型与 typedef 类型）、**`case` 分支标签（`2'd0:`、`default:`）**、**条件里的名字记为读**、**`for` 头声明循环变量**、**`foreach` 读数组并声明循环变量**、**单语句 `always` 之后的语句不被吃掉**、**generate `for` 体里 `always ... begin ... end` 之后的语句不再被裁掉**、**过程赋值两侧的文本**、**`` `define `` 宏名与其名字范围（带参数的、缩进的、以及写在 module 体内的定义都收）** | 62 |
   | `index.test.ts` | 声明查找、位宽折叠、参数 named/positional 覆盖传播、defparam、宏模块、generate 路径 `moduleAtPath`、层次路径不变量、深度/实例截断标记、重解析幂等（不累积旧端口/旧 module）、文件失去最后一个 module 后不留残影、重复 removeFile 幂等、**头文件后到也能经名字表查到（懒建表会失效）、同名形参按源码序先声明者胜出**、**显式的 0 深度/预算表示不设限（正的上限仍会截断，0 则把整条链展开且不报截断）**、**反向边库：`parentsOf` 列出每条 `InstanceSite` 的父边（同一父多处例化各一条，含 `file`/`inst`）、重解析同一文件不累积旧边、删文件收回其边、`edgeEpoch` 随边增删递增、`resolve.instancesOf` 由反向边回解到定义与实例** | 33 |
   | `graph.test.ts` | 端口连线与方向、net 命名空间、containment、unresolved/truncated 问题、深度与节点上限、root 开关、叶子模块自身连线、**过程赋值也是边（label `always`，宽度跟着类型走）**、**图根不是设计顶层时带上祖先实例与父作用域 net（同级不画）**、**按层次折叠：collapsed 实例只留盒子，子树与它的作用域 net 不再展开，且不报 truncation**、**每作用域信号上限是硬上限：按顺序先物化实例端口连线、再 assign 两端、最后端口声明，超出的收进 `cappedScopes`，`signalLimits` 可按路径放宽，胖模块不再挤掉它下面的子框，祖先作用域也受同一上限约束（否则根会被 `prune` 掉）；上限用尽后连不上线的子框不再画（返回给 `visit` 的只有真正画出的子级），其余靠 `...` 分页逐页带出，因此画出的子框都不是悬空的**、**每 scope 一个子框窗口（`childLimits`）：还有下级没画出来的 scope 记进 `pagedScopes`，视图的 `...` 行照旧可点，但把它当“再加一页下级”而不是只能加信号——每页 +`defaultChildLimit` 个下级并顺带放行一页节点预算，胖模块一页页地把几千个子框带出来，而不是停在 `maxNodes` 上死路**、**同 scope 内连接多个下级的内部信号在 `.name`/`.*` 隐式连接下也能推断出方向（不再被视图当纯内部网隐藏）**、**没有显式 `childLimits` 的 scope 也按 `defaultChildLimit` 只画一页（显式 `childLimits` 优先），超出部分进 `pagedScopes`** | 37 |
   | `generator.test.ts` | flatten/compose/stub/auto、参数折叠、assign 圆锥、内部 net 报告、失败原因与回退、生成代码可被自身 parser 重新解析、**共享类型无法随副本带走时的告警**、**隐式 wire 不写进副本、也不变成 wrapper 的端口**、**enum 成员作为 localparam 写进副本**、**只有真被用到的 typedef 丢失时才告警**、**generate 块里有任何内容就回退到 stub**（线/赋值/参数/端口也算） | 30 |
     | `hierarchy.test.ts` | `signalWidth` 把声明里所有维度都算进位宽（**名字前的范围是 packed、名字后的是 unpacked**；`logic [3:0][7:0]` 是 32 而不是 4，`wire [7:0] mem [0:3]` 是 32，参数写成的范围照常折叠）、**`containingDesign` 把深度/预算选项透传给内部建树：不设限时深模块找得到、给浅上限时返回 `undefined`**、**懒构建：`HierarchyBuilder.root` 建出 `children === undefined` 的根、`childCount` 预判直接子级、`expandLevel` 只材料化一层（子级仍 `undefined`、带 `parentPath`/`depth`）**、**懒环检测：自例化节点标 `cycle`/`truncated` 且 `childCount` 归 0，与 eager 一致**、**懒预算：`maxInstances` 命中后截断并标 `truncated`**、**`containingPath` 不建树就给出设计顶层与点号路径（真顶层为自身根、配置顶层打断向上走）**、**`childOnPath` 只下走一段、不误吞前缀兄弟**、**第一条分支：多条父边按 `(file, line, char)` 取最小（跨文件与同文件早行各一例），`entryOf` 返回自底向上的父边链** | 16 |
| `coldstart.test.ts` | 冷启动：故意拖住 `findFiles`，在扫描未结束时就问 `provideDefinition`——不等索引就绪会拿到空答案 | 1 |
| `startup.test.ts` | 启动成本：借 `vscodeStub` 激活真实扩展并把 `findFiles` 桩成抛错——对打开的文件请求 Document Symbols 仍能返回模块（直接解析缓冲区），日志里没有 `[index]` 扫描行；激活时活动编辑器只记录上下文，隐藏的组成视图不调用 `getText`；`package.json` 的 `activationEvents` 不含 `workspaceContains:`（启动不应先搜索 HDL 文件） | 3 |
| `width.test.ts` | 用户类型的位宽：本 module 的 typedef、typedef 链、enum 基类型、`import` 与 `pkg::type`、文件作用域与 `` `include `` 借来的类型、数组 typedef 带维度、struct 退回 1 位、**父与子同名不同类型时各取各的**、互相点名的 typedef 不递归、无 resolver 的 scope 仍为 1、fixture `alu` 的 enum 信号 2 位 | 11 |
   | `resolve.test.ts` | 标识符合法性、workspace/模块作用域引用、包限定 `cfg::X` 解析、参数默认值与位宽中的使用、端口连接/层次读取/点号路径/未声明信号、`name` 取光标下的叶子、重命名时把限定引用收窄到叶子、**import 进来的名字解析到包里的声明**、**拒绝不完整的重命名**（import 来的名字、function/task 形参）、**task 形参解析到函数头**、**enum 成员跳进 typedef 的大括号里**、**声明里名字前的 packed range 不并入点号路径** | 30 |
    | `nets.test.ts` | 读/驱动方向、子端口方向决定连接侧向、事件控制中的信号、无触碰即 unused、过程赋值标 `always`、未解析子模块不猜写、**generate 块里的驱动也算驱动**、**只出现在条件里的名字算读**（`if (en) q <= d;` 里 `en` 有读者、无写者） | 13 |
    | `trace.test.ts` | 信号 / 模块追踪（层次逐跳）：信号——使用处→声明处、端口声明→父实例连接网、output 端口同样跨到父实例、带 packed range 的总线端口声明同样跨到父实例、顶层端口无上层、非端口声明无处可去、信号→子实例连接处、连接处→子端口声明、连接处的父侧网、最底层时信号→模块体内的使用处（无子连接的信号落到 `assign` 的读引用、叶子端口落到驱动它的 `assign`、只用条件门控的信号落到该条件引用）、层次引用 `u1.o` 进子端口/退回父网、未解析光标与 module 名返回 `undefined`、generate 副本按位置去重；模块——定义名向上到父实例（`datapath`→`chip_top.u_dpath`）、实例名向上从包含模块起跳、向下到子实现（`datapath`→`adder.v`/`regfile.v`）、顶层向上无父、`chip_top` 向下扇出、信号光标不是模块追踪、`traceAt` 自动分派；以及基于 `test/fixtures/lib` 的真实跨文件追踪（`datapath.alu_sum` 向下到 `u_adder.sum` 与 `u_regfile.wdata`、连接处再进 `regfile.wdata`；`datapath.carry` 向上跨到 `chip_top.u_dpath.carry`） | 24 |
   | `problems.test.ts` | 未解析 module（generate 只报一次）、猜方向端口、未声明裸名、有效代码零误报、未解析实例不产生级联、跨 module 可见性、按文件/行排序、**共享类型放在头文件时零误报**、**`import` 进来的常量/类型/task 形参零误报**、import 没列出的名字仍然报告、import 进来的 class 仍然安静、跨文件包把 ref 的 kind 定成 param、**命名过程块与块内局部变量零误报**、**`for`/`foreach` 的循环变量零误报**、**select 下标里的限定名/系统函数零误报**、**接口端口不报猜方向** | 25 |
   | `ranges.test.ts` | 位置不变量：遍历全部 fixture 与 CRLF/tab/长行/未闭合注释等 offset 密集源码，断言每个 IR 位置都在文件内、range 不倒置、token 单调不回退；含变异校验（`collect` 命中数为 0 时判失败，防止空断言） | 4 |
    | `config.test.ts` | 配置接线：`HdlConfig` 每个字段都在 config.ts 之外被读过、package.json 里每个设置都被 `readConfig` 读过、数值设置都有正的 minimum（信号上限与组合树深度/预算例外，允许 0 = 不限） | 3 |
   | `globs.test.ts` | 排除规则（`tb/` 目录、*_tb 文件名、build/output）、`*` 不跨目录而 `**` 跨、`**/` 可匹配零层、`?` 单字符、`.` 为字面量、`braceGlob` 形状 | 5 |
   | `naming.test.ts` | 重命名保留字：`lexer.KEYWORDS` 与 `GATE_KEYWORDS` 全集都拒绝（列表必须是二者的超集，防止漂移）、会改变声明含义的关键字逐个断言、普通标识符接受、非法名字给出原因 | 5 |
   | `tokens.test.ts` | 语义 token：模块类型/实例名/端口/信号/参数/函数/typedef/系统标识符着色、点号路径只着色叶子、作用域限定偏移、排序与去重、未解析名字不着色、**类型位置的名字即使跨文件无法解析也着色**、**enum 成员的声明与使用都按 parameter 着色** | 14 |
| `jump.test.ts` | 跳转关系表：signal/module/instance 命中并给出目标范围、索引延迟就位后目标才解析出来、不可解析的名字不入表、未索引的文件不建表、光标落在名字首尾都算命中、删文件后关系表失效、**无关文件被 add 后命中表不重建、removeFile 只丢指向它的表（其余保留）、表按 LRU 淘汰（命中刷新最近序）、同目录出现新定义后命中改指向、header 借名后命中改指向**、**`` `NAME `` 宏引用落到它的 `` `define ``（命中范围从宏名而非反引号起算）、别处文件里的 `` `define `` 也能命中** | 15 |
| `scale.test.ts` | 规模：`moduleAtLine` 二分与逐行扫描在 200 module 的每一行等价、200 signal 的 module 只看见自己的声明（名字表不串模块）、关系表构建一次复用、删文件后关系计数归零（不泄漏） | 3 |
   | `providers.test.ts` | 真实 provider 借桩 `vscode` 跑起来（headless）：module 词与 instance 名跳到声明、信号读跳到声明、 hover 不受影响、被排除的文件在打开前没有关系、**打开后跳转生效**、关闭后恢复、**workspace symbol provider 列出全部 module 且按名排序、按路径命中（`legacy`→`fifo`）、无匹配清空、落点在 module 名上；`goToModule` 转发系统 `#` 框** | 10 |
   | `webview.test.ts` | 连接图 webview：真实内联脚本（`SCRIPT`）跑在桩 DOM 上、图由真实 `buildGraph` 生成——**一个 module 一个容器框、信号是框内行且按方向排序（再按跨框连线做 barycenter 对齐）**、端口边从源框的行落到**目标框内同名信号行**（不落到外框、不落到 header）、同组 `assign` 两头从框右侧外凸、chevron 折叠后行消失且连线回退到 header、双击 header 发 `collapse` 给扩展、层次折叠的框标 `+` 且不画子节点、**上级 module 默认隐藏、每框左右默认各带一个 `+`：左缘 `+` 点击发 `ancestors` 消息逐级揭示上一级（每点一次向上长一层；没有上级则是探测钮，点后确认无内容即隐藏）、上级已显示的框左缘 `−` 收回自己的父框；右缘 `+` 点击发 `{type:'descendants', path, expanded:true}` 只揭示自己的一层直接子模块、再点子框的 `+` 再下一层直到叶子、已展开的框右缘 `−` 收回自己的下级、叶子/焦点外的框右缘 `+` 是探测钮点后无内容即隐藏**、**框缘 `+`/`−` 放大到 18px 并各带一个透明命中框（至少 20×20，点它等同点字形）**、搜到一个信号后整组模块连同全部信号一起保留、**同一对框之间的连线不乱交叉（两线在一侧的顺序相对另一侧不发生翻转，同点扇出不算）**、**只画面向 I/O 的信号行（端口、以及被下级端口接走的内部信号），纯内部网不占行**、**每框信号数超过 `hdl.connectView.graph.maxSignalsPerGroup`（默认 40）时由 core 裁短、框内多出一行 `...`（该组键出现在 `cappedScopes` 里），点它发 `{type:'moreSignals', path}` 向扩展要下一页，没被裁的组没有这一行**、**下级还在子框窗口后（`pagedScopes`）时框内多出一行独立的 `more children`，点它发 `{type:'moreSignals', path, children:true}` 要下一页下级；`...` 只管本框信号、`more children` 只管下面的子框，两者并存的框两行都画且各发各的**、**层次布局下把一个框拖到兄弟上再展开，被拖的框保留落点、兄弟被推开而不是叠在一起**、**每个 module 框的 header 自带一个搜索框（`foreignObject` 内 `input.boxsearch`，**居中**：左仍是实例名、右仍是 module 名）：在框内输入后按 Enter 才开始搜索（只打字不发消息、不改画面），**搜索范围只限本框自己的信号与它的直接子模块**（按名字、不按路径，不下钻孙辈），原有画面原样保留、只把匹配的框/信号行新增进来并加 `match` 高亮，同时（防抖后）发 `{type:'boxSearch', path, query}` 让扩展展开被分页/信号上限藏起来的匹配；框内搜索不整组带出——搜模块名只新增那个空框、不会把它名下的全部信号行也拉进来；每框都有搜索框、清空再按 Enter 即还原（“打字不搜”“隐藏匹配加在当前画面之上且不动已有内容”“孙辈名字从本框搜不到、直接子名从本框搜得到”“搜索框居中在实例名与 module 名之间”数例）** | 31 |

    | `graphpanel.test.ts` | 扩展侧图根：借 `vscodeStub` 起真实的 `IndexService` + `GraphPanel`——**从 module 定义（裸 module 根）打开图时向上走索引、把走查重定到设计（chip_top）**，节点落在真实实例路径 `chip_top.u_dpath.u_adder`、`ancestorsLeft=2`；真正的顶层自身为根、`ancestorsLeft=0`；**加宽模块（60 个下级、180 根网）展开后被信号上限裁到一页，`pagedScopes` 让 `...` 行把下一个下级页放行，两页后全部下级到场、`pagedScopes` 清空**；**per-box 搜索：对 250 个下级的 `wide` 搜 `u200`、对 60 个端口的 `many` 搜 `p55`，初始都因分页/信号上限未画出，`{type:'boxSearch'}` 后分别把被裁的下级框与被截的端口都带出来（搜索同时抬高祖先子框窗口与父作用域信号上限）**；**搜内部信号：`evt` 里只在敏感表出现的 `wire en` 既非端口也非赋值端点、本不在图里，搜 `en` 后由 `includeSignals` 单独带出** | 5 |
     | `relations.test.ts` | 信号/module 关系数据库（纯核心）：哈希稳定且随文本变化、信号读写者与端口连线（含方向）、子模块未解析时不猜方向、按文件聚合并按名排序、全量构建、增量复用未变文件并重算已变文件、内容不变时增量零改动且序列化逐字节一致、**子模块端口方向变化时父文件也被重算**（跨文件依赖）、删除已移除的文件、序列化往返、拒绝版本不符/结构损坏的载荷、统计计数、空库 | 13 |
     | `hierarchyDb.test.ts` | 层次库（纯核心，§5.6）：`HierarchyDbBuilder` 与索引侧 `HierarchyBuilder` **逐行相等**（沿 `chip_top` 深渊三层，逐字段比对 path/instName/moduleName/depth/file/range/unresolved/cycle/generate/truncated——两条路都经同一个 builder，换库对视图不可见）、重复 module 名合并（children 拼接、首个定义供 file/nameRange）、反向边与 tops、配置顶层即使被例化也保留、`firstParentPath` 自底向上走到顶层、`childrenOf`/统计、序列化往返、拒绝旧版本/结构损坏、深度上限（到顶的带子节点标 `truncated` 且不材料化下级）、generate 前缀进实例名 | 8 |
     | `hierarchyStore.test.ts` | 层次库 v3 编解码（纯核心，§5.6）：分片哈希稳定、零填充且在 `[0,256)` 内且大小写敏感；generation 分片 round-trip（不写反向边 `parents`、保留边的 `df`/`cc`）；manifest 计数与 tops 拷贝；拒绝旧 version、非法 generation（`../`、空串）、损坏 manifest/shard；`firstParentChain` 根先行、缺失/环/空名返回 `undefined`；`edgeDefFile`/`edgeChildCount` 默认值 | 8 |
     | `indexDb.test.ts` | 定义库（纯核心，§5.6，artifact）：列出文件/模块/端口/例化边、未解析例化仍记录并标 `ok=false`、统计（files/modules/ports/instances）、序列化往返、拒绝旧版本/结构损坏、对真实 fixture 也能构建 | 5 |
     | `graphDb.test.ts` | 图库（纯核心，§5.6，artifact）：每个顶层得到非空连通图、解析不到的顶层被跳过（不记空图）、统计求和、序列化往返（`graphDbStats` 相等）、拒绝旧版本/无 graph 的条目、tops 有序 | 5 |
     | `database.test.ts` | 宿主层落盘：借 `vscodeStub` 起真实 `DatabaseService` 打到临时目录——刷新把关系写到 `.vscode/rtlens/relations.json`（键为目录相对路径、连线信号正确）、第二个实例 `load()` 能读回第一个写的库、编辑后增量刷新只重算 1 个文件并复用另 1 个、`pickRefreshMode` 取回所选模式；**自动更新：`load()` 后一次索引变化（`watchDocument`）在防抖后把库写到盘上；`load()` 之前的索引事件（激活扫描）不写盘；关闭 `autoUpdateDatabase` 时索引变化等满防抖也不写盘，而一次显式 `scheduleAutoRefresh(0)`（文件集合变更的强制路径）照写照盘**、**指纹跟着索引里的文本而不是磁盘字节：文件在索引之后被外部改写、字节变了但索引未更新时指纹不变、不误重算（`collectInputs` 走 `indexedText`）**、**刷新时状态栏先同步转成 `$(sync~spin)` 再开跑，抛错也经 `finally` 落回静止标签** | 9 |
     | `catalog.test.ts` | 分类数据库宿主层落盘（§5.6）：借 `vscodeStub` 起真实 `CatalogService` 打到临时目录——刷新把 `index.json`/`hierarchy/`（`current.json` + 分片）/`graph.json` 写到 `.vscode/rtlens/`（含 `source` 指纹、`top.children[0].m` 正确，边的 `df`/`cc` 落盘）、第二个实例 `load()` 读回、**`CompositionStore` 按分片读回且 `topFile`/`modulesAmong`/`firstParentChain` 与构建结果一致、一次索引变化后同步收回（视图回退内存）**、`load()` 之前不写盘、之后索引变化自动刷新、关闭 `autoUpdateDatabase` 时索引变化不写盘而显式 `scheduleAutoRefresh(0)` 照写 | 6 |
    | `scanPaths.test.ts` | 扫描根接线：借 `vscodeStub` 起真实 `IndexService`（`findFiles` 按根桩定）——默认只扫工作区文件夹、`databasePaths` 追加外部目录、`databasePathsOnly` 打开后丢开工作区只留配置根、被显式列出的文件即使命中 `exclude` 也索引、工作区之外的文件（`../ext/b.v`）能进入关系数据库 | 5 |
    | `views.test.ts` | 组合树形状与图分页：借 `vscodeStub` 起真实 `CompositionTreeProvider`/`GraphPanel`——**250 个下级的宽模块一次性返回全部 250 个子级（不再有 load-more 行），有子级的节点 `Collapsed`、叶子 `None`，展开叶子无内容**；**`modelFor` reveal 在很宽的模块里也能找到第 221 个子级**；**图的 child page 跟随 `defaultChildLimit`：首次揭示下级的框就只画一页（配置 13 个），点一次 `moreSignals {children:true}` 再加一页（13→27→40），而不是先把节点预算画满再收窄**；**自动定根：配置 `topModules` 时以该顶层为根且光标移动不改变它，未配置时按活动编辑器所在 module（`moduleAt`）定根并随光标在 module 间切换（`top`↔`leaf`），光标落在首个 module 之前的注释行时回退到该文件首个 module**；**组合 webview 行点击接线：借 `vscodeStub` 起真实 `CompositionViewProvider`、喂一个 `{type:'open', path}`，断言它把该行的实例节点连同父文件发给 `revealInstance`（而非根文件 + line 0），节点带 `nameRange`/`moduleNameRange` 使命中落在例化语句上**；**跟随编辑器高亮当前 module：未配置顶层时 `setContext` 把根定在设计顶层并随光标只用 `{type:'highlightPath', path}` 移动高亮（从 `top` 移 `leaf` 时根不变、不重发 `rows`，高亮落到 `top.u`）；配置顶层时根钉住，按 module 名在整棵树里定位（`leaf`→`top.u`，`top`→`top`）**；**组合树用自己独立的深度/实例上限（`hdl.connectView.composition.*`），默认不设限：全局 `maxDepth` 为 1 时组合树仍展开整条链，而把 `composition.maxDepth` 设为 1 只收窄组合树、不动全局树**；**无限规模下的 provider 接线：全局 `maxDepth` 为 1 时 `CompositionTreeProvider` 仍按组合上限建出整条链（`hierarchyRoot` 不被全局深度截断），因为它取根走 `compositionHierarchy` 而非 `svc.hierarchy`**；**被截断/环的子树在 badge 里标注 `cycle`/`truncated`，不再伪装成叶子**；**光标落在例化上时高亮该例化行：整个例化语句都算——指向例化名（`u_ctrl`）、所例化的模块名（`control`），或它接线的任意一行（`.busy(busy)`、`.a(operand_a)`，哪怕在例化名下方好几行、参数 `#(.WIDTH(8))` 也算）都定位到 `chip_top.u_ctrl`/`chip_top.u_dpath`，而光标不在任何例化上（如 `module` 关键字行、`assign` 行）时回退到本模块行 `chip_top`**；**标题按钮接线：`setExpandedAll(true/false)` 分别向 webview 发 `{type:'setExpanded', expanded}`，webview 回报 `{type:'expandState', expanded}` 时宿主把 `hdl.compositionExpanded` 上下文键按布尔值发布（`true`/`false` 两个方向都校验，避免把状态写死）**；**refreshIndex 后重新索引能带出新层次：先建一棵只有根 module 的树，再往索引里加一个两级深的子模块（`top` → `sub` → `leaf`）并 `refresh()`，断言树从新索引重建到 `['top','top.u','top.u.l']`——`refresh()` 若复用旧的缓存 `HierarchyNode` 就只会留住根行**；**模块过滤：同一棵树（`a` 只在 `u_b` 下、`a` 内含 `other`）下 `filterModules:['a']`，模式 1 断言行仍为 `top/u_b/u_a2/u_d/u_c`（`u_t` 没了）、`u_a2` 的 `childCount` 为 0 且 badge 含 `filtered`，模式 2 断言 `u_a2` 及其子树整没了（`top/u_b/u_d/u_c`），空过滤表则 `u_t` 照旧在**、**ready 握手：视图在文档装好消息监听前就建了根（`setContext` 早于视图打开），`{type:'ready'}` 到达时补发一次整棵树且只发一次（否则先发的消息被丢弃、视图一直空白）**、**reindex 不清空已在屏的树：`idle→indexing→ready` 的中间态不再抹掉 payload，重新就绪后行数与内容都还在**、**`index.refresh()` 先公告 `indexing` 再拆索引：订阅者按 `ready` 门控重建，避免从半拆的索引重建而丢掉根与展开前沿**；**打开/切换文件时 `setContext` 让 `highlightPath` 带 `collapseOthers: true`——首次定位与换文件为 true，同文件内移动光标为 false，非 HDL 编辑器返回后回到同一文件也不算切换，`revealPath` 不携带该字段**；**过滤条目支持文件/目录路径：夹具 `FILTER_TREE`（`leaf_a` 与 `a` 同在 `rtl/a.v`、`b` 在 `rtl/sub/b.v`、`top` 从 `top/top.v` 例化三者）下，`filterModules:['rtl/a.v']`（相对文件）让模式 2 只剩 `top/u_b`——按**定义文件**而非例化文件过滤；`['rtl']`（相对目录）只剩根 `top`；`['/w/rtl/sub']`（绝对目录）只砍 `b`，`u_a`/`u_la`/`u_la2` 全在；模式 1 下 `rtl/a.v` 保留 `u_a` 但 `childCount` 为 0、badge 含 `filtered`，`leaf_a`（无子级）仍作为普通叶子留在 `u_la2`**、**首次定根即带出根的直接子级：索引里 `top` 例化 `sub` 时 `setContext` 的首帧就是 `['top','top.u']`（不靠刷新或光标材料化）** | 25 |
    | `dbfilter.test.ts` | 组合树模块过滤端到端（借 `vscodeStub` 起真实 `IndexService` + `CompositionViewProvider`）——配置变更后加文件过滤生效（整树 → `['top','top.u_b']`）、激活后经 `onDidChangeConfiguration` 触发 `refreshIndex` 同样生效、DB 源（`CatalogService` 落盘后经 `CompositionStore.open`）同样生效；**泄漏防护三例：模式 2 光标移到被过滤子树深处不发该子树的任何 `children`（`materializeTo` 在隐藏层停住）、模式 1 光标移到被剪枝实例下方同样不发（该实例行 `childCount` 为 0 且 badge 含 `filtered`）、展开请求与配置变更竞态时隐藏层只回空 `rows`（`childRows` 守卫）** | 6 |
       | `netsview.test.ts` | Nets webview 脚本的真实运行：借 `vscodeStub` 拿到 `netsView.ts` 导出的 `SCRIPT`，用 `new Function` 喂给桩 DOM——**空过滤时逐行画出全部信号且按方向/读取者描述**、**空格分隔的多词 fuzzy：每个词各作子序列匹配、全部命中才保留（`clk n` 只留 `clk_enable` 且 `c`/`l`/`k`/`n` 都高亮）**、**带未命中的词则整列为空并显示 “No signal matches”**、**ready 握手：脚本末尾发 `{type:'ready'}`，宿主收到才补发 payload（首个 post 不再因文档尚未就绪被丢弃）**、**reindex 期间保留已在屏的行（`onDidChange` 仅在 `state === 'ready'` 时刷新）** | 5 |
           | `compview.test.ts` | 组合 webview 脚本的真实运行：借 `vscodeStub` 拿到 `compView.ts` 导出的 `SCRIPT`，用 `new Function` 喂给桩 DOM——**新建根时每一级默认折叠，只画根行（该行 chevron 为 `▶`）**、**点三角逐级展开/折叠：先露出直接子级（变 `▼`），再点子级的三角露出一层，直到叶子**、**搜索（fuzzy，与 Nets 同款）只保留命中的实例/module 行及其祖先、命中字母高亮（`<b>`）、并强制展开这条路径使命中可见**、**空格分隔的多词 fuzzy：每个词各作子序列匹配、全部命中才保留（`u mid` 命中 `u_mid` 且两词字母都高亮、`mid zzz` 无命中）**、**点行发 `{type:'open', path}` 让扩展在源码里定位**、**收到 `{type:'revealPath', path}` 展开沿途并 `scrollIntoView` 到该行**、**收到 `{type:'highlightPath', path}` 展开沿途、滚动到该行并只给它加 `.sel` 高亮（换一个 module 时旧高亮清除、空路径清空高亮）**、**折叠某祖先会隐藏整棵子树（含孙辈）：被隐藏的行仍压入祖先栈，否则一个被隐藏的中间行之后的孙辈会因先弹掉了折叠祖先而被误画**、**宽模块（4000 个下级）一次点击列出全部 4001 行、再一次点击全部折回**、**标题栏的全局展开/折叠：收到 `{type:'setExpanded', expanded:true}` 一次展开全部层级、`false` 一次折回根部**、**webview 回报整棵树的展开状态：新建树报 `false`、全展开报 `true`、手动只展开一层不翻转（只在变化时才回传）**、**懒加载：只带根行时点开一个未加载层级会向宿主发 `{type:'expand', path}` 且不立即重绘，宿主回 `{type:'children', parentPath, rows}` 后把这一层就地插到父行之后并展开、新子级默认折叠，已加载层级再点则本地折叠不再请求（`expand` 只发两次）**、**超大层分片投递：`children`/`childrenMore` 逐块插入，中间块不重绘、最后一块（`more:false`）按序整层渲染**；**`highlightPath` 带 `collapseOthers: true` 时先折叠所有带子级的分支，再只展开并高亮目标路径（目标已选中时重发同一条高亮仍会折叠，stutter 快速返回不吞掉折叠）；不带该字段的高亮保持手动展开的兄弟分支不变** | 16 |
    | `wordHighlight.test.ts` | F8 词高亮：core 的 `findWordMatches`（空词零命中、整词匹配——`a` 不命中 `ab`/`a1`、行首行尾、同行多次、`$display` 贴标点仍 standalone 而 `foo$display` 不命中、Unicode 词（`数据` 不命中 `数据库`）、重叠候选不死循环）与 `randomHighlightColor`（注入的 rand 决定 hue、不同 draw 色相不同）；宿主侧 3 例借 `vscodeStub` 跑真实的 `WordHighlighter`——**非 HDL 文件里 F8 高亮每个 standalone 出现处**（词取自编辑器自己的 word pattern，不再走 `wordAtPosition`）、同一词再按关闭而另一词叠加、光标在空白上 no-op | 12 |

       共 503 个用例，因此可在无 GUI 环境运行：其中 379 个完全不依赖 `vscode` 模块，`providers.test.ts` 的 9 个、`coldstart.test.ts` 的 1 个、`startup.test.ts` 的 3 个、`webview.test.ts` 的 31 个、`graphpanel.test.ts` 的 5 个、`database.test.ts` 的 9 个、`scanPaths.test.ts` 的 5 个、`views.test.ts` 的 25 个、`netsview.test.ts` 的 5 个、`compview.test.ts` 的 16 个、`wordHighlight.test.ts` 的 3 个、`catalog.test.ts` 的 6 个与 `dbfilter.test.ts` 的 6 个则由 `src/test/vscodeStub.ts` 提供的 `vscode` **桩模块**驱动——`Module._load` 拦截 `'vscode'` 后动态 `import('../extension')`，跑的是真实的 activate/scan/provider 代码，`webview.test.ts` 则借同一个钩子拿到 `graphPanel.ts` 导出的 `SCRIPT`，用 `new Function` 喂给桩 DOM 执行，而不是复刻一份逻辑。其中 `config.test.ts` 是**接线守卫**：直接读源码双向校验“没有死设置”——`HdlConfig` 的每个字段必须在 config.ts 之外被读过，`package.json` 的每个设置必须被 `readConfig` 读过，数值设置必须有正的 `minimum`。两个方向都做过变异校验（把 `semanticHighlighting` 换成常量、往 manifest 里塞一个没人读的属性，对应用例都会失败），`ranges.test.ts` 同样做过偏移量变异校验。本轮新增的 parser/tokens/probabilities 分支也逐条做过变异校验：去掉 `isTypedefName` 里的 file-scope 分支、去掉 package 限定、`qualifiedNameAt` 的 token 数写错、取消 `shareFileTypedefs` 的自引用、忽略 module 内部遮蔽、去掉无端口列表实例化的 scope 判定、去掉 `classifyTypeUses`、`referenceTokens` 里 `kind === 'type'` 的着色分支、flatten 里“按类型聚合成一条”的告警与“本 module 已有 typedef 就不重复报”——十一处变异都会被对应用例抓住。后续两轮（隐式 net、`import`/`bind`）又逐条做了变异校验：去掉 `inAlways` 判定（过程赋值不再被判未声明）、放宽层级路径判定（`u.o` 变成一个叫 `o` 的 net）、不写 `implicit` 标记、副本与 stub 各漏一处过滤、不记录 `import` 语句、认不出 `import pkg::*`、不按名字过滤 import 列表、跨文件包不再定 kind、跳过包与自身的环、丢掉 import 名字的 owner（定义跳到别的文件）、让重命名不再拒绝、重新给 module 类型的 ref 定 kind、把 `bind`/`let` 加回 block 开关键字、不标记 bind 里的 ref——二十处变异都会被对应用例抓住。enum 那一轮又做了九处：不给第一个没有显式取值的成员补 0、不把文件作用域的成员下发到 module、不记成员的声明引用、整个 enum 解析跳过、下发之后不再重定 ref 的 kind、成员值看不到前面成员的值、无引用的 typedef 也告警、丢掉的 typedef 从不告警、把 typedef 自己算成使用者——九处都会被抓到（单元测试或 e2e 至少一处失败）。generate 那一轮又做了九处：generate 体不再分发语句、else 分支不读、不给赋值打 generate 标记、不给声明打、不给 parameter 打、生成器只拦实例、只拦 generate 里的赋值、只拦 generate 里的声明、把过程块关键字收窄成只有 `always`——九处也都会被抓住。路径那一轮（保留层级路径里的下标、按下标选 generate 副本、嵌套块路径、内联 `genvar`）又做了十二处：解析引用时不保留下标、不记下标里的名字读、嵌套循环丢掉外层标签、实例前缀被内层覆盖、光标链在下标处断开、跨文件跨 generate 块读不到信号、不按块路径选声明、数组实例元素匹配不到实例、block 切片少跳一次 `begin : label`、header 里的 `parameter` 当成端口、参数默认值在空 scope 里折叠、循环头里的内联 `genvar` 不识别——十二处都会被单元测试或 e2e 抓住（其中 `begin : label` 的两处是等价变异：else 分支的标签改由 `blockCtx` 兜底读出，行为一致）。过程块与图这一轮又做了十四处：不再跳过 `: label`、过程块里不再解析声明、case item 标签退回只认标识符、typedef 判定放宽到任意 ident（`arr[i] = 0;` 被误判成声明）、`for` 头第一段不再建声明、`foreach` 不再声明循环变量、条件不再记为读、无条件分支的 `bodyEnd + 1`、`labelEnd` 不再遇 `?`/`=` 退出、`for` 头改回按逗号切分、`integer` 关键字不再映射到 integer、nets 不再把 condition 当读、图里重新跳过 `inAlways` 赋值、过程边的 label 退回 `assign`——十四处全部会被单元测试或 e2e 抓住。select 与接口端口这一轮又做了五处：`indexRefs` 退回逐 token 平扫、`isAnsiSlice` 不认裸接口端口、`scopeKinds` 不填、猜方向的过滤里不跳过接口端口——前三处与 nets 那一处会被对应用例抓住；第四处（猜方向的过滤）是等价变异（`guessDir` 只在非 ANSI 占位端口上设置，ANSI 接口端口走 `parseAnsiPort` 的接口分支，到不了那条过滤），所以没有留在代码里。同一轮还加了一处 Nets 的：`add()` 不再把 `$` 开头的名字收进 net list（`$clog2(DEPTH)` 里的 `$clog2`），对应 nets 用例会失败。子程序体这一轮做了五处：Nets 不再跳过 `local` 的赋值、图不再跳过、赋值不标 `local`、声明不标 `local`、函数体不再算过程体——前四处会被对应用例抓住；最后“`inProcedural: false`”是等价变异（`scanFunctionBody` 根本没有例化分支，`inProcedural` 在这里没有消费者，值仍按“函数体是过程体”写）。这一轮还砍掉了两处一开始写下的代码：函数体里的 ref 标记（子程序体不产生 `context` 引用，无人消费）与 generator 里跳过 `local` 声明的过滤（`flatten` 先拒绝带 function/task 的 module，够不着）。 generate 条件这一轮做了四处（条件不记引用、记成运行时条件、Nets 丢掉它、Nets 写成 `read by always`）——四处都被对应用例抓住。generate 作用域那一轮做了五处：拒绝信息里少了参数/端口的块名、Nets 不再把 generate 路径归并、图里 `netInfo()` 不再回退到块内声明、`generateScopes()` 不看声明、路径不再去掉下标——五处都会被对应用例抓住。 位宽这一轮做了十三处：不再区分 packed 与 unpacked、没声明的门词仍算引用、门词一律当原语、参考不记 `select`、`signalWidth`/`widthOfPort`/`widthOfVar`/`declWidth` 各忽略一段维度、单比特下标仍算一位、节点用下标位宽、生成器把 unpacked 写在名字前、扁平化的多维端口没有位宽、门原语被报成缺失模块——十三处都会被对应用例抓住（头两处与 `signalWidth`/`declWidth` 两处各补了一个用例才抓住）。 收尾这一轮做了四处：跨文件的裸 interface 端口又报方向猜测、占位端口不再记录 `declaredType`、字符串拼接照旧折成假数字、compose 生成的端口方向弄错而 e2e 不查——四处都会被抓住（字符串那处第一版只挡了后置的、前置的漏了，补上 `{"ab", 4'h1}` 那个用例才抓住）。跳转关系表这一轮做了三处：instance 条目不记 `target`（查表拿不到目标，`jump.test.ts` 与 `providers.test.ts` 共 5 个用例失败）、`removeFile` 不再失效已缓存的关系表（删掉的文件仍能“跳”到过期位置，`jump.test.ts` 2 个用例失败）、打开文件时不补索引（被排除文件打开后依然没有跳转，`providers.test.ts` 1 个用例失败）——三处都会被抓住。用户类型位宽这一轮做了五处：`typeWidth` 不再向 scope 要 `typeOf`（8 个用例失败）、`scopeFor` 不装 resolver（同样 8 个）、去掉互递归的 `seen` 保护（链上打转，1 个用例栈溢出而失败）、`childScope` 不换成孩子自己的 resolver（孩子那 32 位的信号折成父 module 同名类型的 8 位，1 个失败）、`underlyingType` 不认 `pkg::type`（2 个失败）——五处都会被抓住。冷启动这一轮做了一处：`provideDefinition` 不再等索引就绪（`coldstart.test.ts` 1 个用例失败）——会被抓住。名字表与跳转关系表这一轮做了十三处：`lendHeaderDecls` 不再失效名字表（头文件后到时查不到）、`moduleAtLine` 二分差一（起始行命中的 module 查不到，scale 用例失败）、命中不 touch（缓存退化成 FIFO，LRU 用例失败）、`removeFile` 不丢指向它的表（无关文件的关系被误杀）、`removeFile` 退回整表清空（无关文件的关系被误杀）、保存的未命中不再重试（延迟就位的 module 永远查不到）、重名 module 出现不推 `preferEpoch`（同目录新定义改不了命中，jump 用例失败）、header 借名不推 `preferEpoch`（借名后命中不改正指向）、关系表不记 `targetFiles`（删除文件时无法粒度丢表）、名字表改为后写者胜（同名形参与借名遮蔽出错）、预算条件写成 `&&`（超限不淘汰）、丢表不减关系计数（泄漏）——前十二处都会被对应用例抓住；第十三处（`descend` 实例的 `idx` 合并规则）是等价变异：`byHead && byBase` 在当前 parser 下不可能同时命中（路径按点拆段、`instances` 键没有带下标的键），idx 规则从不参与决定，保留它是因为它一字不差就是被替换的"线性扫描先出现者胜"。这一轮先跑变异、后补用例：`invalidateScopeIndex`、两处 `preferEpoch` 与后写者胜共四处一开始都活着，补了 4 个用例（`index.test.ts` 2 个 + `jump.test.ts` 2 个）才全部转红。本轮新增的 **宏（`` `define ``）** 分支也做过变异校验：不存 `macros`（parser 不再记宏，`jump.test.ts` 两个宏用例失败）、`macroRef` 不标 `isMacro`（`resolveAt`/`buildFileJumps` 都走旧路径、宏用例失败）、`jump.ts` 不用 `resolveMacro` 而直接 `resolvePath`（宏用例失败）、`expandChain` 不把 `macroRef` 加进 `parts`（宏用例失败）、`wordAtToken` 不为 `macroRef` 设 `nameRange` 为去掉反引号的范围（原先跳到反引号处、宏用例对“落在名字上”的断言会暴露）、`renameAllowed` 不拒绝 `macro`（宏不能重命名，但若允许，rename 逻辑照样不会重写 `import` 风格的用法；留意即可）、`buildFileJumps` 仍把 `token.range.start` 当宏引用起点（用例“start on the name”会失败）。六处变异均会被新增用例或既有逻辑抓住。每作用域信号上限这一轮做了三处：`addNetNode` 去掉上限判定（`graph.test.ts` 的“上限是硬上限 / 胖模块不挤掉子框 / 祖先上下文不被 `prune` 掉”三例转红）、上限命中后不写 `cappedScopes`（同样三例转红）、`visit()` 把 `connectScope` 挪回子实例连线之前（端口先占上限，“胖模块”一例因其连线 net 被裁而转红）——三处都会被抓住。本轮还修了一个 generate 体扫描的边界并做了变异校验：`parseGenerateFor` 里 `begin : label` 匹配 `end` 必须从 `begin` 本身起算（`matchBlock` 落在非开块词上会取到第一个闭块词），否则循环体里第一个 `always ... begin ... end` 的 `end` 被当成整个块的结束，其后语句（如 `assign rdata = ...`）整条丢失；把起始点改回 label 之后，`parser.test.ts` 新增用例转红。

    graph 这一轮（多下级之间的内部信号）也做了变异校验：把 `.name` 与 `.*` 分支的 `parentSideDirection` 补丁各自去掉——两种隐式连接下的内部信号都会退回 `direction=undefined` 而被视图隐藏，两处都被 `graph.test.ts` 抓住。下级分页这一轮又做了两处：`connectChildren` 的 `childLimits` 命中后不写 `pagedScopes`（“子框窗口分页”一例失败；若只看 `pagedScopes` 字段，后果是视图的 `...` 行收不到，超过窗口的下级永远出不来）、预算放行逻辑去掉后 `moreSignals` 只涨信号不涨节点预算（`graphpanel.test.ts` 的“两页后全部下级到场”一例失败，中途卡在 `maxNodes` 上）——两处都会被抓到。本轮新增的扫描根接线也做了两处变异校验：把 `collectInputs` 的归属判断改回“必须有 owner”（工作区外的文件被丢出关系数据库）、把 `databasePathsOnly` 判断短路掉（配置根模式下仍去扫工作区）——两处都被 `scanPaths.test.ts` 抓住。（组合树曾按 `defaultChildLimit` 分页，后按“下级全部直接列出、逐级展开/折叠到叶子”的要求移除：`windows`/`moreChildren`/`ensureRevealWindows`/`showMoreChildren` 命令与 `CompositionItem.more` 一并删除，`defaultChildLimit` 只留给连接图）这一轮又做了三处变异校验：把 `render` 的 `Collapsed` 改回 `Expanded`（有子级的节点默认展开，“starts collapsed”一例失败）、去掉 `setContext` 里“光标在首个 module 之前时回退到文件首个 module”的兜底（新建树在注释行上定根为空，“falls back”处转红）、图侧子框窗口初值写成 `?? childPage`（第一次 `moreSignals {children:true}` 放出两页而不是配置的一页，`graphpanel.test.ts` 的“两页后全部到场”一例失败）——三处都会被抓住。`config.test.ts` 接线守卫自动罩住 `defaultChildLimit`：manifest 里少这个设置、`readConfig` 不读它、或 `minimum` 不设正数，对应用例都会失败。子框分页与信号分页分行这一轮又做了两处：把 `hasMoreNets` 退回 `cappedScopes.has || pagedScopes.has`（`...` 行再次兼职下级分页——一个下级还没画完、信号却未被裁的框会同时画出 `...` 与 `more children` 两行并走进一个同步死循环，整个面板卡死，`webview.test.ts` 新增的“separate more-children row”用例超时转红；这正是把两种分页拆开的动机）、把 `hasMoreChildren` 去掉或让 `more children` 行不再发 `children:true`（下级分页行消失或退化成信号分页，同名两例失败）——两处都会被抓住。默认子窗口这一轮又做了两处：`connectChildren` 的 `climit` 退回 `?? Infinity`（没有显式 `childLimits` 的 scope 又把节点预算画满，`graph.test.ts` 新增的“没有显式窗口的 scope 按 `defaultChildLimit` 分页”与 `views.test.ts` 的“首次揭示就是一页”两例失败）、图侧子框点击的 `signalLimits` 基准写回 `?? 0`（信号上限配置较大时，点一下反而把本 scope 的信号额度砍到一页，`views.test.ts` 的“点一次加一页 27、再点 40”转红）——两处都会被抓住。层次布局避让这一轮做了一处：`layoutHierarchical` 末尾不再调 `settleHeld`（被拖过的框不再作为锚点，列自顶向下重排时把兄弟压到它身上，`webview.test.ts` 新增的“拖到兄弟上再展开不重叠”一例转红）——会被抓住。per-box 搜索这一轮做了八处：`rebuildSearchReveal` 命中子框/信号后不把该 scope 的 `signalLimits` 抬到 `Infinity`（`graph.ts` 的父 scope 信号上限仍卡着，被搜的下级框画不出来，`graphpanel.test.ts` 的 `u200`/`p55` 一例转红）、`signalsOf` 只收 `signalUsage` 的键而不带 `def.ports`（没用到的端口名不在 usage 里，搜 `p55` 找不到，同例转红——这正是第一版漏掉端口时抓到的真 bug）、webview `visible()` 的框内分支不先并入 `searchBase`（框内搜索退化成“只留匹配”，原先显示的框被丢掉，`webview.test.ts` 的“adds its matches without hiding what is on screen”“brings a hidden match in on top of the current view”“highlights the matching signal row without dropping others”三例转红）、把 Enter 门禁挪回 `input` 事件（每次击键即搜索，“starts on Enter, not while typing”一例转红）、框内匹配退回按路径的 `matches` 而不是按名字的 `boxHit`（搜模块名时该 scope 下每个信号行因路径含查询词被保留，“the added box brings no unrelated signal rows”转红）、框内匹配的范围限制去掉（`boxHit` 允许任意深度的后代匹配，从 top 搜 `inner` 会命中孙辈 `top.u_mid.u_inner`，“reaches only the box own signals and its direct children”一例转红）、把搜索框钉回 header 右缘而不是居中（“the search field is centred between the instance name and the module name”一例转红）、生成框 header 时不 render `foreignObject`/`input`（“every module box carries its own search field”一例转红）、webview `buildGroups` 对 `direction` 未定义的 net 不再放行框内搜索命中（没方向的内部信号行被默认过滤掉，“a box search can reach an internal signal that is normally hidden”转红）、扩展端 `connectScope` 不再按 `includeSignals` 补建节点（只在敏感表出现的 `en` 永远进不了图，“a box search reaches an internal signal the graph never carried”转红）——十处都会被抓住（第二处是本轮实现中真实发生、补上端口后才转绿的）。本轮新增的**信号追踪**改为层次逐跳后做了七处变异校验：忽略“使用处→声明处”（`if (!onDecl)` 恒假）、把层次引用当成本地信号（`sameModule` 判断去掉）、信号不再匹配子连接（`conn.refs.some(matches)` 去掉）、去掉目标去重（展开的 generate 副本各出一跳）、子端口落到父文件（`child.file` 换成 `mod.file`）、端口跨层忽略父侧引用（`conn.refs.length` 恒假）、层次引用认错实例（按末段而非首段匹配实例）——七处都会被 `trace.test.ts` 抓住。随后两轮又做了三处：`expandChain` 左走 `]` 时不检查 `[` 前是不是真实链步（带 packed range 的声明 `wire [7:0] name` 又拼成 `wire.name`，总线端口上追踪/定义失效，会被 `resolve.test.ts`/`trace.test.ts` 抓住）、去掉最底层的使用处回退（`targets.length === 0` 恒假，叶子端口不再落到使用处）、使用处只扫 `assign` 不扫事件/条件/`generate` 引用（只用条件门控的信号丢失落点）——三处都会被抓住。组成树自动定根这一轮做了两处变异校验：让 `setContext` 直接返回（不再定根，`views.test.ts` 新增用例在“配置顶层为根”处转红）、把自动跟随时用的 `key` 写成常量（同一文件内换了 module 也不重建根，用例在“跟随光标切到另一个 module”处转红）——两处都被抓住。组成树这一轮把 webview 从“扁平行 + 缩进”升级为“**层次化 + 逐级展开/折叠 + Nets 同款搜索**”：早期 webview 把树拍平、只靠缩进表示层级且没有折叠，先后被要求恢复折叠、又要求保留搜索，最终形态是 webview 内自绘折叠三角（`▶`/`▼`，新建根时每一级默认折叠）——`compView.ts` 的 `CompRow` 增加 `parentPath`，SCRIPT 维护 `collapsed` 集合与 `search()`（命中行 + 祖先 + 强制展开），`package.json` 的 `hdl.composition` 仍为 `type: webview`。这一轮对 SCRIPT 做了四处变异校验（在 `compview.test.ts` 上）：去掉新建根时“把所有带子级的行设成 collapsed”的初始化（打开即全展开，“every level starts collapsed”一例失败）、点三角的 `toggle` 改成扩到最深而不是只动一层（一次露出两层，“expands one level at a time”一例失败）、`search()` 只保留命中行而不回填祖先（路径断裂，搜索用例里 `top`/`u_mid` 消失而失败）、`revealPath` 不 `expandAncestors` 就直接滚动（祖先仍折叠、目标行没画出来，reveal 一例失败）——四处都会被抓住。同一轮还修了组合视图的**行跳转**并做了变异校验：webview 起初把 `{ file: cachedFile, path }`（根文件 + 无行号）发给 `revealInstance`，于是点任意一行都跳到根文件第 0 行；改成先在 `cachedRoot` 里 `findByPath(msg.path)` 取回该行自己的 `HierarchyNode`（`file` 是写下该例化的父文件、带 `nameRange`/`moduleNameRange`）再发命令——把接线改回 `{file: cachedFile, path}`（跳错文件/第 0 行）或不再 `findByPath` 直接发 `path`，`views.test.ts` 的“a row click jumps to its instance, not line 0”一例都会失败。组成树“跟随但树不搬家 + 高亮当前 module”这一轮又做了四处变异校验：webview 的 `highlightPath` 不写 `selected`（高亮行不出现，`compview.test.ts` 的“only the current module row”一例失败）、`show()` 恒 `changed = true`（每次移动光标都重发 `rows`，`views.test.ts` 的“no rebuild when only the highlight changes”一例失败）、`locate` 不先判根 module（配置顶层时 `top` 自身高亮不出来，`views.test.ts` 的“the root module highlights itself”一例失败）、未配置顶层时不用 `containingDesign` 而退回按光标 module 定根（从 `top` 移 `leaf` 会把根搬成 `leaf`，`views.test.ts` 的“moving inside the design does not move the root”一例失败）——四处都会被抓住。组合树独立深度/预算这一轮做了三处变异校验：把 `compositionHierarchy` 里的上限改回全局 `maxDepth`/`maxInstances`（组合树重新受全局深度上限约束，`views.test.ts` 的“组合树不受全局深度上限约束”一例失败）、`Builder` 把显式 0 当成真实上限（`maxDepth: opts.maxDepth ?? 32`，`index.test.ts` 的“显式 0 深度/预算”与 `hierarchy.test.ts` 的“透传选项”以及 `views.test.ts` 的组合树不限深三例失败，共 4 处转红）、`containingDesign` 不透传 `opts` 而硬编码 `{ maxDepth: 128 }`（深链在浅上限下仍被建出，`hierarchy.test.ts` 的“浅上限返回 undefined”一例失败）——三处都会被抓住（其中 Builder 那处由三个文件共同兜底）。空格分隔的多词 fuzzy 这一轮做了两处变异校验（Nets 与 Composition 各一套同款实现）：把 `fuzzy` 的 `tokens = q.split(/\s+/)` 换回 `tokens = [q]`（空格查询退化成“把整串含空格当子序列”，`clk n` 在 `clk_enable` 上因找不到空格后的 `n` 而一个都匹配不到、`u mid` 在 `u_mid` 上找不到 ` ` 后接 `m`，`netsview.test.ts` 与 `compview.test.ts` 的多词用例都转红）、去掉“逐词累加、任一未命中即 `return null`”的短路（只匹配第一个词，`clk zzz` 仍会列出 `clk` 相关行，`netsview.test.ts`/`compview.test.ts` 的“未命中词清空结果”一例失败）——四处都会被抓住。F8 词高亮扩展到任意文件任意单词这一轮做了四处变异校验：把 `findWordMatches` 的 standalone 判定去掉一侧（`a` 重新命中 `ab`，“whole-token matches only”转红）、换回 ASCII 的 `[A-Za-z0-9_$]` 边界（`数据` 命中 `数据库`，Unicode 用例转红）、`WordHighlighter.toggle` 仍走 `wordAtPosition` 而不是 `getWordRangeAtPosition`（非 HDL 文件里光标下的词取不到，“non-HDL file”宿主用例转红）、`package.json` 的 F8 `when` 收窄回 `verilog || systemverilog`（manifest 与 keybinding 不再对任意编辑器生效；此为声明性约束，由人工审阅 + 本条记录兜底）——前三处会被 `wordHighlight.test.ts` 抓住。无限规模这一轮做了五处变异校验：让 webview 折叠可见性只对未被隐藏的行压栈（`if (!found && !hide)`——被隐藏的中间行之后的孙辈会因先弹掉折叠祖先而被误画，`compview.test.ts` 的“hides its whole subtree, grandchildren included”一例失败）、把 `views.ts` 的取根退回 `svc.hierarchy`（组合 provider 又受全局 32/20000 截断，`views.test.ts` 的“provider roots at the composition limits”一例失败）、去掉 `rebuild` 里 `truncated`/`cycle` 的 badge（被截断/环的子树看起来像叶子，`views.test.ts` 的“a cut subtree is marked”一例失败）、去掉 `childOnPath` 的段边界判定（`path.charCodeAt(end) === '.'`——`top.u` 会误吞 `top.u_extra`、`wide.u2` 会误吞 `wide.u29999`，`hierarchy.test.ts` 的“sibling name that merely prefixes”与“wide module lists every instance”两例失败）、让迭代 `expand` 在深度上限弹出帧时不从活跃路径集合删名（同一 module 的第二个兄弟被误判成环，`hierarchy.test.ts` 新增的“深度上限不把同名兄弟误判成环”一例失败）——五处都会被抓住。跟随光标到例化这一轮做了两处变异校验：让 `instanceLocalAt` 退化为只按行匹配（丢掉字符级 `inRange` 精度）——`module top (...); leaf u (...)` 的声明行会把高亮误抬到 `top.u`，“follows the editor”一例转红；只认 `nameRange`/`moduleNameRange` 而不认整个例化语句 `range`（丢掉 `.busy(busy)`/`.a(operand_a)` 这些接线行与 `#(...)` 参数覆盖）——指向接线不再跟随到对应例化，新增的“points at an instantiation or its connections”一例转红（`range` 已包含名字与模块名两段，故不再单列那一支）——两处都会被抓住。组成视图标题栏的展开/折叠按钮这一轮做了五处变异校验：`reportExpanded` 去掉“只在状态变化时才回传”的门槛（每次重绘都发 `expandState`，手动只展开一层后 `states()` 多出一个 `false`，“reports whether the whole tree is expanded”一例转红）、`collapseAll` 不再把带子级的行记回 `collapsed`（点 Collapse all 后树仍是展开的，“expands and collapses every level”一例转红）、webview 消息处理里把 `expandAll`/`collapseAll` 对调（上述两例都转红）、宿主 `setExpandedAll` 发错消息类型（`views.test.ts` 的“expands/collapses all”一例转红）、`expandState` 处理里把 `!!msg.expanded` 写死成 `true`（该例断言 `true`/`false` 两个方向，写死时 `false` 方向转红）——五处都会被抓住（第五处正是把用例从只发 `true` 补成双向后才抓住的）。`package.json` 的 `view/title` 按钮替换是声明式接线（`when` 用 `hdl.compositionExpanded` 上下文键二选一），无 headless 断言，靠人工在 Extension Host 里核对。刷新索引带出新层次这一处做了变异校验：把 `refresh()` 退回“复用缓存 `HierarchyNode`”（`this.rebuild(this.cachedRoot ? undefined : this.cachedRootModule)`）——新加的两级子模块一棵都出不来，`views.test.ts` 的“refresh rebuilds from the reindexed hierarchy”一例转红。模块过滤这一轮做了四处变异校验：模式 2 去掉“命中即跳过整棵子树”的 `continue`（模式 2 退化成模式 1，`u_a2` 又出现，“filter mode 2”一例转红）、`pruned` 恒为 false（模式 1 不砍子树，`u_t` 又出现，“filter mode 1”一例转红）、`childCount` 不置 0（过滤行仍画出折叠三角、不再当叶子，“filter mode 1”转红）、`readConfig` 里把 `filterMode` 读成常量 1（用户设 2 也当 1，“filter mode 2”转红）——四处都会被抓住。过滤条目支持文件/目录这一轮又做了四处变异校验：路径条目只按 module 名匹配（四条新用例全红）、相对路径不按 workspace folder 解析而按进程 cwd（相对文件/相对目录/模式 1 三例转红，绝对路径一例仍绿）、`isUnder` 恒 false（两条目录用例转红，文件用例仍绿）、去掉 module 名优先（`filterModules:['a']`/`['b']` 两条既有用例转红，证明名字优先不是巧合）——四处都会被抓住。`config.test.ts` 接线守卫自动罩住这两个设置：manifest 里少一个、`readConfig` 不读、或 `filterMode` 的 `minimum` 不设正数，对应用例都会失败。Ctrl-T"全局模糊搜索 module 并跳转"最初用自建 quick pick，后改为复用系统 `#` 框（注册 `WorkspaceSymbolProvider` + 删掉抢占 `Ctrl+T` 的绑定，命令改转发 `workbench.action.showAllSymbols`）——这一轮做了三处变异校验：`subsequence` 恒返回 true（provider 过滤失效，`zzz_nope` 不再清空，`providers.test.ts` 的“无匹配查询清空”一例转红）、把落点从 `def.nameRange` 换成 `def.range`（跳到 `module` 关键字处而非名字，字符位由 7 变 0，“points at its declaration with the cursor on the name”一例转红）、把 `goToModule` 命令改成空实现（不再转发系统命令，“reuses the system symbol search”一例转红）——三处都会被抓住；不注册 provider 或删掉过滤用的局部变量则先被 `noUnusedLocals` 编译守卫挡下。早期自建 quick pick 版本也留下三处记录：去掉 `matchOnDescription`/`matchOnDetail`、`moduleItems` 倒排、落点用 `def.range`——同样都会被抓住（该版本的 quick pick 与 `IndexService.moduleItems()` 已随改造删除）。

按需懒加载组合树这一轮做了九处变异校验：`HierarchyBuilder.root` 又把 `children` 填成 `[]`（懒根一建出来就“已展开”，只带根行的视图永远点不开子级，`hierarchy.test.ts` 的“lazy root has no children until asked”转红）、`expandLevel` 递归材料化整棵子树（与 eager 无异，`compview.test.ts`/`views.test.ts` 的层级消息断言失败）、`childCount` 恒返回 0（行上没有折叠三角、宿主也不发 `children`，“predicts its two instances”转红）、`containingPath` 退回调 `buildHierarchy` 再 `findByPath`（懒路径又建整棵树，深链用例变慢且 `hierarchy.test.ts` 的“does not materialise”语义失效）、`CompViewProvider.materializeTo` 不再把已展开节点入 `pending`（宿主不回 `children`，webview 停在旧行，`views.test.ts` 的“each opened level arrives nested”转红）、webview 的 `toggle` 对未加载层级直接 `delete collapsed` 而不发 `expand`（点了三角却没请求，子级永远不来，`compview.test.ts` 的“asks the host”转红）、`children` 处理器不把新子级设为折叠（一层点击漏出两层，“splices the level in”转红）、`children` 处理器按 `rows.push` 追加到末尾而不是插到父行之后（平铺顺序错乱，用例的 `u_top` 落在 `u_a` 前失败）、宿主 `setExpandedAll(true)` 只发 `setExpanded` 而不先 `expandAll` 材料化（展开全部只见已加载层级，`views.test.ts` 的过滤/展开用例读不到完整行）——九处都会被抓住（其中两处是本轮实现中真实发生、补上 pending 与“新子级默认折叠”后才转绿的）。

分类数据库这一轮做了七处变异校验：`HierarchyDbBuilder.root` 的 `range` 写回 `nameRange`（与索引侧根的整模块 range 不一致，`hierarchyDb.test.ts` 的逐行相等一例立刻转红——这正是本轮修掉的一处真实偏差）、`buildHierarchyDatabase` 漏掉 `range` 字段、`HierarchyModule.range` 不填、`source` 指纹不写入（组成树分不清新鲜与否）、`CatalogService.load` 不做指纹比对（陈旧库被当成新鲜）、`onIndexChange` 不把 `fresh` 置假（编辑后视图仍读旧库）、`freshHierarchy` 不检查 `fresh`（同上）——前四处被 `hierarchyDb.test.ts` / `catalog.test.ts` 抓住，后三处被 `catalog.test.ts` 的 provider 一例抓住。`catalog.test.ts` 的两条否定断言（`load()` 之前不写盘、关闭 `autoUpdateDatabase` 不写盘）都**等满防抖（> 500ms）**才断言，与 `database.test.ts` 同款，避免“定时器还没触发”造成的假绿。

本轮两条缺陷（组成树 / Nets 视图空白、状态栏 `build DB` 点击无响应）的修复也做了变异校验：删掉 `compView` 宿主的 `{type:'ready'}` 分支或脚本末尾的 `vscode.postMessage({ type: 'ready' })`（视图打开时首发消息仍被丢弃，`views.test.ts` / `netsview.test.ts` 的 "rows are delivered after the webview reports ready" 转红）、把 `netsView` 的 `onDidChange` 门控退回无条件 `refresh()`（reindex 清索引期间把空表推上屏，"reindexing keeps the rows on screen" 转红）、把 `compView` ctor 里 `idle`/`indexing` 清 payload 的分支加回（同款用例转红）、把 `index.refresh()` 的 `setState('indexing')` 挪到拆索引之后（订阅者从半拆的索引重建、组成树丢根，`index: a rebuild announces indexing before it clears the index` 转红）、把 `collectInputs` 的哈希退回 `textSync`（索引构建后被外部改写的文件被误判重算，"fingerprint follows the indexed text" 转红）、把 `refresh()` 入口的状态栏赋值移到第一个 `await` 之后或去掉 `finally`（点击无即时反馈、抛错后 spinner 不回位，"status bar announces a running refresh" 转红）——六处都会被对应用例抓住。每文件夹的 `setImmediate` 让位与 `findFiles` 去掉 `maxResults`（原 20000）属响应性改动，只在真实宿主里可观测，没有对应断言。

组成树"打开/切换文件折叠其余分支"这一轮做了四处变异校验：`fileOpened` 恒 false（首次定位与换文件都不带标记，`views.test.ts` 的折叠标志用例在首个 `true` 处转红）、每个 defined file 都带标记（同文件内移动光标也折叠，同一用例在同一文件断言处转红）、webview 的 `foldOthers` 恒 false（分支不折叠，`compview.test.ts` 的 "a file open folds every branch" 一例转红）、stutter 快速返回去掉 `&& !foldOthers`（已选中时重发高亮被直接返回、折叠没发生，同一用例的重发断言处转红）——四处都会被抓住（前两处若把 `lastContextFile` 改成只写不读，会先被 `noUnusedLocals` 的 TS6133 挡下，故用仍读取该字段的等价改写复核）。

v3 分层存储与按需加载这一轮做了四处变异校验：把 manifest generation 的路径校验（`/^g-[A-Za-z0-9-]+$/`）换成只判字符串（`../` 与空串被当作合法 generation，`hierarchyStore.test.ts` 的“拒绝外来 manifest”一例转红）；去掉 `ensureRoot` 里根的 `source.expand(root)`（首帧只剩根行——这个变异一开始**没有被抓住**，因为既有用例都经 `refresh()` 或光标材料化；补了 `views.test.ts` 的“首次定根即带出根的直接子级”一例后才转红）；去掉 webview `rows` 处理器里“根行不折叠”的 `path !== rootPath` 判定（根也进 `collapsed`，`compview.test.ts` 的根展开用例与另外 8 例转红）；让 `buildHierarchyDatabase` 不再回填边上的 `df`/`cc`（分片读回后 `df` 为空——`views.test.ts` 仍绿，因为索引回退路径由 `HierarchyDbBuilder` 直接从 module map 重算；补了 `catalog.test.ts` 对落盘边的断言后才转红）——四处最终都会被抓住。

启动阻塞这一轮做了三处变异校验：把 `workspaceContains:**/*.v` 加回 `activationEvents`（`startup.test.ts` 的 manifest 一例转红）；在 `activate` 里加一行 `void svc.ensureReady()`（`findFiles` 桩抛错，大纲请求后日志出现 `[index] scan failed`，`startup.test.ts` 的“no workspace scan”一例转红）。第三处去掉 `followEditor()` 里的 `if (this.visible)` 守卫，激活即解析活动缓冲区，`startup.test.ts` 的“hidden composition”一例与 `views.test.ts` 的隐藏视图用例转红。三处都用 edit 还原后重新编译。`syncEditor` 的 `setTimeout(0)` 是调度让位，headless 下只能验证“不阻塞激活返回”，没有对应用例。

组成树过滤防泄漏这一轮做了两处变异校验：去掉 `materializeTo` 循环顶部的 `dropped`/`pruned` 守卫（光标移到被过滤子树深处时照常逐级展开并向 webview 推送该子树的子行——模式 2 产生孤儿行、模式 1 把标着 `filtered` 的“叶子”行下面整棵子树重新拉上屏，`dbfilter.test.ts` 的两条光标用例转红）、去掉 `childRows` 的同款守卫（webview 的 `expand` 与配置变更竞态时，已成为隐藏层的节点照常回带子行，“an expand that raced a config change”一例转红）——两处互不掩盖：只留一处时另一处的用例仍绿（光标两例由 `materializeTo` 守卫罩着、竞态一例由 `childRows` 守卫罩着），两处都在时六例全绿，两处都去时三例全红。两处守卫在未配置过滤时恒短路（`compositionFilterModules` 为空时 `dropped()`/`pruned()` 直接返回 false），既有 `views.test.ts`/`compview.test.ts` 的懒加载与过滤用例不受影响。

2. **fixture 集**：`test/fixtures/` 覆盖纯 Verilog-1995、Verilog-2001 ANSI、SystemVerilog、generate for、interface、package、宏、`ifdef` 变体。
3. **集成冒烟**（105 项 `ok`）：`src/tools/e2e.ts` 加载 fixture 目录，断言索引统计、层次与参数传播、graph 结构（含“过程赋值也在图里”）、flatten/compose/stub/auto 的可解析性与错误信息，逐项打印 `ok`，末尾输出 `ALL CHECKS PASSED`。 flatten 与 stub 的产物都回读一遍；compose 之前只查了结构，现在也回读：重建出来的端口表最容易在方向或位宽上丢东西，而回读后的 `ports` 才是用户真正拿到的 module。 还新增了关系数据库冒烟：按文件/模块/连线计数，全量刷新写入 `.vscode/rtlens/relations.json`、序列化可回读、增量刷新在无变动时零重算。
4. **静态检查**：`npm run check` = `tsc --noEmit` + `e2e`；`npm test` = 编译 + 全部单测。
5. **headless provider 验收**：`providers.test.ts` 借 `vscodeStub` 激活真实扩展，逐个调用 `provideDefinition`/`provideHover`/`provideDocumentSymbols`/`provideWorkspaceSymbols`，覆盖“激活 → 扫描 → 排除规则 → 查表跳转 → 系统 `#` 符号搜索”的完整链路（`tb/` 里的文件在打开前没有跳转关系，打开后立即有）。VS Code 侧的 TreeView、Webview 交互、wrapper 预览/保存仍需真实 Extension Host；当前环境无 `code` CLI，尚未执行（见 §11.3）。

CI：`npm run check && npm test`（或 `make check`）。

**打包**：`make` = 装依赖（缺 `node_modules` 时）→ `tsc` → 单测 + e2e → `vsce package`，产物是 `dist/rtlens-<version>.vsix`（45 个文件、约 206 KB，含 `out/core/jump.js`、`out/core/relations.js`、`out/core/hierarchyDb.js`、`out/core/indexDb.js`、`out/core/graphDb.js`、`out/vscode/database.js`、`out/vscode/catalog.js`）。`vsce` 由 `npx --yes @vscode/vsce@4` 按需取用，不写进 `devDependencies`；离线环境可以 `make vsix VSCE=./node_modules/.bin/vsce`。`.vscodeignore` 把 `src/`、`test/`、`out/test/`、`out/tools/`、`*.js.map`、`.omo/**`（本地 agent 工具状态，git 忽略）全部排除，vsix 里只剩运行时真正需要的 `out/extension.js`、`out/core`、`out/vscode`、`package.json`、`README.md`、语法与图标（另有 `AGENTS.md` 一直随包发出——未被 `.vscodeignore` 排除，属既有行为，与本轮改动无关）。`make contents` 打印将要打进去的文件清单。注意 README 里不要放指向被排除文件（如 `DESIGN.md`）的相对链接——vsce v4 会把它当成错误而不是警告，直接让打包失败（无 repository 字段时）。marketplace 图标必须是 PNG（`resources/icon.png`），而活动栏的 `viewsContainers` 图标是另一个文件 `resources/icon.svg`——两处曾经互相覆盖过一次，改动时要一起看。两个文件的职责不同：**活动栏 SVG 是单色蒙版**，VS Code 按 Activity Bar 前景色给它上色，所以它必须是**透明背景 + 单色字形**（`viewBox="0 0 24 24"`、只用 `currentColor`），一旦像早先那样铺一块铺满画布的底色矩形，蒙版就退化成一块实心方板（用户看到的"白板"）；marketplace PNG 则可以带底色、有品牌色，二者不再同源。

---

## 9. 里程碑

| 阶段 | 交付 | 验收 |
|------|------|------|
| M1 | 脚手架 + 语法高亮 | `.v/.sv` 有配色，注释/折叠正常 |
| M2 | core：lexer/parser/indexer/resolve + 单测 | fixture 全绿 |
| M3 | 语言功能：跳转/符号/hover/references/rename | 5 类跳转全部正确 |
| M4 | Composition webview | 层次树可展开/折叠、可搜索、可跳转 |
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
| 连接图 | `src/core/graph.ts`、`src/vscode/graphPanel.ts` | 完成；自包含 SVG 图，无 CDN/worker；一个 module 一个容器框、信号是框内行，连线锚到目标框里的对应信号行 |
| 组成树 / nets / problems | `src/vscode/compView.ts` + `src/vscode/views.ts`、`core/nets.ts`、`core/problems.ts` | 完成；Composition 为 webview 自绘层次树、`CompositionTreeProvider` 只留定位/取根；nets/problems 的判定逻辑在 core，可单测 |
| 跳转/hover/references/rename/符号 | `src/vscode/providers.ts` | 完成；F12 命中实例名时跳到被例化的 module（`followDefinition` 关掉则改为在组成树中定位），rename 拒绝遮蔽同名符号并只替换限定名里的叶子 |
| wrapper 生成 | `src/core/generator.ts`、`src/vscode/generate.ts` | 完成；三种策略 + auto 回退，先预览后显式保存；generate 块内的连线含循环变量时拒绝并回退 stub |
| 打包 | `package.json`、`resources/icon.svg` | 完成；`main` 指向 `out/extension.js` |

### 11.2 与设计稿的差异

- **分类数据库按「Hybrid on develop」落地**：§5.6 的四个分类库（`index.json` / `hierarchy/` / `graph.json` / `relations.json`）现已全部落盘到每目录的 `.vscode/rtlens/` 下；§5.9 原稿只设想「仅 `relations.json` 落盘、层次显示库留内存」。实际做法是**两者并存**：develop 分支上已实现的内存引擎（实例边库 `parentsOf` 反向边、惰性 `HierarchyBuilder` 行模板）继续作为**回退**，另加持久化的 `hierarchy/`（v3：`current.json` manifest + 256 个按 module 名哈希的分片，`CompositionStore` 按需读取），**两条路给出的行逐字段一致**（`hierarchyDb.test.ts` 断言），换库对组成树不可见。`index.json` / `graph.json` 按 §5.6 定为 **artifact**：写盘可检视 / 可 diff，但不接线回读——激活仍解析源码建 `HdlIndex`（§2.1「索引不落盘」），连接图每次都按交互参数重取，因此 `graph.json` 只是默认图快照。§5.9 里 `childIndex`/`parentIndex`/`levelTemplate`/`entryIndex`/`epoch` 那套命名是设计稿的设想名，实现保留了其**语义**（反向边惰性、模板记忆化、缓存不影响正确性），但以 `parentsOf` 与 `HierarchyBuilder` 的现有名字呈现。
- **新鲜度用 `source` 指纹而非 `epoch`**：每个落盘库带一个 `source` 字段（`sourceFingerprint(files)`，按 `rel:hash` 排序后哈希），组成树只在指纹与当前工作区一致时读 `hierarchy/`，否则回退内存；这比 §5.9 的「按索引代数 `epoch` 失效」更弱耦合（跨会话可判定新鲜与否），也是 `catalog.test.ts` 里「编辑后同步收回」一条所验证的行为。

- **未解析实例的激活弹窗删掉了**（用户报的"安装报错"）：`HDL: 8 instantiation(s) reference a module that is not in the index. See the HDL Problems view.` 有两个问题——8 与 Problems 视图里的 4 条对不上（toast 按 instance 数，Problems 按行+module 去重并跳过 gate 原语），而且 Problems 树本来就订阅索引变化自动刷新，toast 不提供任何新信息；索引一完成就弹，看起来更像安装失败。现在 `IndexStats.unresolvedInstances` 直接取 `problems.unresolvedInstances().length`（这条数字只有在 Problems 视图与索引日志里出现，两者永远一致）。
- **生成对话框是原生 API 组合**（QuickPick 选模式 → InputBox 改名 → 打开未保存文档预览 → modal 确认 Save/Copy/Discard），不是独立 webview。好处是代码着色、撤销、保存对话框全部由 VS Code 提供，且"写盘前必须显式确认"这条约束在代码里只有一处出口。
- **实例路径的作用域**：`buildHierarchy` 的根路径就是模块名，因此"某实例的路径"只在产生它的那棵层次树里有意义。生成流程先复用 TreeView 当前持有的层次根（`CompositionTreeProvider.hierarchyRoot`），否则在 design top 中逐个查找能容纳全部选中路径的那一棵；跨作用域的选择由 `composeModule` 明确报错，而不是生成半成品。
- **flatten 保留全部连续赋值**：flattened copy 是独立模块，删掉"看起来没人用"的 assign 会悄悄改变行为，因此一律保留；compose 才做 assign 圆锥裁剪（只复制真正喂到选中集合的赋值，并给出被丢弃数量的 warning）。
- **flatten 的 localparam 用实例处的折叠值**，而不是模块声明的默认值——`top.u_dp2 #(.DEPTH(2))` 生成的是 `localparam DEPTH = 2;`，副本与被选中的那一段设计行为一致。
- **端口数 > 256 直接拒绝**这条安全阀未实现：上限取自层次实例预算，生成的端口数天然有界。若要加，先补 `composeModule` 的计数断言。
- **图是单个自包含 webview**：`layout` 在 webview 内分帧跑，图模型经 `postMessage` 结构化克隆传入，页面里没有任何 `innerHTML`（全部 `textContent`/`setAttribute`），因此源文件名与实例名不可能变成标记。
- **拖动节点不会触发点击**：pointer 移动超过 3px 即判定为拖拽并吞掉随后那一次 `click`，否则每次挪动节点都会顺手把面板缩放到该子树。
- **重绘按帧合并**：`mousemove`/`wheel` 只排一次 `requestAnimationFrame`，不在每个事件里重建整棵 SVG；800 节点下整图重建已经超过一帧。
- **平移不再被重绘打断**：`draw()` 末尾曾每次把 `drag` 置 `null`，第一次 `mousemove` 排的重绘随即清掉拖动状态，空白处平移只够抖一下；现在拖拽状态只在 `mouseup` 清掉。节点的 `mousedown` 同时加了 `stopPropagation()`（否则会冒泡到 svg 的 pan 处理被覆盖，节点永远拖不动）。
- **首次布局收敛后自动适配视图**：布局以原点为中心，初始恒等视图把原点放在 SVG 左上角，负坐标的一半（含许多信号）落在画布左上角外面，看起来"整张图偏左"。`fitView()` 在布局完成后（且用户尚未平移/缩放/拖节点）把包围盒居中并缩放填满画布；双击同样回到 fit 而不是硬重置为恒等视图。
- **图的根不是设计顶层时带上祖先上下文，默认不画、每框左右默认各带一个 `+`、左缘 `+` 逐级揭示上一级**：只看"当前 module 内的信号"漏掉了例化它的模块。`showGraph`/`showGraphForSelection`/`setGraphRoot` 都带上所在层次树的根（`composition.hierarchyRoot` 或光标 module 展开出的 root），`GraphPanel` 用 `pathChain` 算从根到所选节点的祖先链。**若拿到的根本身就是个裸 module 定义**（右键 module、文件里展开出的 root），`setNode` 用 `containingDesign`（配 `HdlIndex.instantiatorsOf` 反向走索引）自底向上找到最近的设计根、把节点/焦点重映射到真实实例路径（`chip_top.u_dpath.u_adder`）后再 `pathChain`，否则这条定义看不到任何上级、左缘 `+` 只会探测为空。**默认不画这些祖先，也没有"跨级"的链顶开关**：左缘 `+` 点击一次把**紧邻的上一级**上级挂上来（父作用域的 net 通过端口连到根；每点一次向上长一层，直到顶层；没有上级则 `+` 是探测钮，点击确认无内容后隐藏）；上级已显示的链上框左缘是 `−`，点击收回自己的父框及以上。webview 里按 `up = rootDepth - depth` 对每个框判定画哪个标记，点击改发**目标值** `shown`——`+` 发 `setAncestors(ancShown + 1)` 长一层、`−` 发 `setAncestors(up)`，扩展端按 `ancestors.slice(-shown)` 切片交给 `buildGraph`；`ancestorsShown`/`ancestorsLeft` 随 graph 消息回传，webview 本地先动数字再发 `ancestors` 消息。顶层的图仍只有一个 root 节点，行为不变。
- **根节点也能高亮**：层次根的 `path` 是空串，图消息里的 `focus` 判空必须用 `!== undefined` 而不是真值判断，否则打开顶层 module 的图时什么都不会高亮，"只看邻居" 也就无从触发。
- **不再让非命中模块变暗**：曾经 `applyHighlight()` 给命中集的补集加 `.dim`（`opacity: .12`），于是打开任何一张图、或点中一个节点，焦点邻域之外的 module/行/连线都被压到几乎看不见——现在整张图始终以正常不透明度显示。高亮（`highlight`）只保留给"只看邻居"复选框做过滤，`withGroups()` 扩组那条路径不变；`.dim` 规则与 `applyHighlight()` 一并删除。
- **框缘 `+`/`−` 放大并加命中框**：`sideMark()` 画的是框缘外的小 `<text class="chev">`，字号只有 11px，鼠标很难点中。现在给它加 `sm` 类（18px、加粗），并在字形下垫一个透明的 `.smhit` 矩形（22×24，`pointer-events: all`）分担点击——两者都绑同一 `click`/悬停处理，且都带 `lm`/`rm` 类（查询仍按 `text` + 类名定位，命中框按 `rect`），18px 的字形不再需要像素级瞄准。
- **链接按层次显示、按层次折叠**：默认布局从力导向换成按 `depth` 分列（`layoutHierarchical`，列距 = 列内最宽的框 + 90，列居中），连线沿列走向穿过实例树，"谁例化谁"不再取决于力导向的收敛结果；`hierarchy layout` 开关可切回力导向（切换时把 `gpos` 里的 `laid`/`moved` 一起清掉，否则列坐标会被当成已收敛的布局冻住）。折叠是**双击实例**：盒子留下（标 `+`），`buildGraph` 收到 `GraphOptions.collapsed` 后 `visit()` 直接返回——子实例与该作用域的 net 都不展开，且**不记 `truncated`**（有意为之，不是预算截断）。webview 的本地 set 让盒子即时反应，扩展端 `GraphPanel.collapsed` 随每次请求回传权威集合；把图 re-root 到某节点时会丢掉会遮住新根及其祖先链的折叠项，避免空图。单击聚焦因此**延迟 200ms** 才发 `focus`（双击要取消它——先 re-root 再折叠只会折叠掉刚成为根的那个盒子）；层次布局下拖过的框记 `moved`，列不再覆盖它的坐标。**折叠信号行**（框头 chevron）是另一回事：纯 webview 状态、不请求扩展，见 §5.3。
- **一个 module 一个框，信号是框内的行，连线锚到行上**：信号跟着它的 module 走（分组键就是 id 的 `::` 前缀），每组一个容器框、框里一行一个信号——"谁的信号"一眼可见，跨模块的线也不再在一堆散点里打结。连线不停在外框：`anchorOf` 按对端组中心选左右边缘，net 端锚在行高上，实例端按 `e.port`/`e.signal` 在**对端框里**找同名行（`portRow`），找不到才回 header 中心；同组的 `assign`/`always` 画成框右侧外凸的弓形，不穿框。框头 chevron 折叠信号行是 **webview 本地状态**（只改画法、不请求扩展），折叠后该组连线回退锚到 header，连接不会消失；层次折叠仍是双击 + `+` 标记（core 收缩），两个集合独立。搜索/邻域的命中集经 `withGroups()` 扩成整组，但**只用于"只看邻居"的过滤**——不再有 `dim`：所有框、行与连线始终以正常不透明度显示。模型层 `core/graph.ts` 一行没动——分组、锚定、折叠全是画法，`graph.test.ts` 的 27 个用例原样通过，画法本身由 `webview.test.ts` 用桩 DOM 跑真实内联脚本覆盖（23 例，见 §8）。这一轮还给每行加了**跨框 barycenter 对齐**（§5.3）：每条可见的线找出它牵的两行，两边都取对方行号均值作排序键、迭代到稳定，两框之间的线不再扇状交叉；只影响画法，core 模型与 `graph.test.ts` 依旧原样通过。
- §5.3 里"导出 SVG/PNG""点击节点后右侧列出 ports 面板""JSON 分批投递""超限自动降到 2 跳"均未实现：当前是单条消息投递（800 节点规模足够），超限时按配置截断并在图上标 `truncated`。
- **上级 module 改为默认隐藏、每框左缘默认 `+`、逐级揭示上一级**：曾经 `setNode` 把整条祖先链全传给 `buildGraph`，mid-tree module 一打开就把各级父实例全画出来。现在祖先默认不画，也没有唯一的链顶开关——**每个框左缘默认都带 `+`，点击把紧邻的上一级挂上来**（发 `setAncestors(ancShown + 1)`；父作用域的 net 通过端口连到根），没有上级的框该 `+` 是探测钮，点击确认无内容后隐藏；上级已显示的链上框左缘是 `−`（点击 `setAncestors(up)` 收回自己的父框及以上）。做法是 `GraphPanel` 记 `ancestorsShown`（默认 0），`refresh()` 按 `ancestors.slice(-shown)` 切片交给 `buildGraph`，graph 消息带上 `ancestorsShown`/`ancestorsLeft`；webview 里 `draw()` 先由根框（`head.path === model.root`）算出 `rootDepth`，`drawGroup` 对每个框 `up = rootDepth - depth` 判定：`up < ancShown` 画左缘 `−`（点击 `setAncestors(up)`）、否则 `ancLeft > 0` 时画左缘 `+`（点击 `setAncestors(ancShown + 1)` 长一层）、`ancLeft == 0` 时画左缘 `+` 探测钮（点击后加入 `probedUp` 隐藏），本地先调数字让框即时反应，再发 `{type:'ancestors', shown}` 让扩展重建。与既有"层次折叠 `+`"（双击收起子树的 `+`）不冲突：前者在框**左缘**、后者在任意被折叠的实例框 header。仅当根不在设计顶层、确有父实例时才出现，顶层图行为不变。
- **下级 module 默认隐藏，`+`/`−` 按 module 各自独立，逐层展开**：图默认只画根的框与它自己的信号，**左缘**是上级链的开关（每框左缘默认 `+`，逐级揭示上一级、无上级探测隐藏；上级已显示的框 `−` 收回），**右缘**是下级的开关——每个有子实例且位于焦点子树的框各自带一个 `+`，点它只揭示**该框自己**的直接子实例（再点子框的 `+` 只再长出那个框的一层，直到叶子；该框已展开则显示 `−` 收回自己的下级）；无子实例的叶子框、或子实例不在焦点子树里的框（祖先上下文），右缘 `+` 是探测钮，点击确认无可揭示的下级后就隐藏。下级展开因此是**按 module 独立**的：没有"一次全展开/收回"的全局级数开关。为此 `core/graph.ts` 把 `GraphOptions.showDescendants`（布尔）换成 `expanded`（`Set<string>`/`string[]` 的已展开路径集合；`undefined` = 预算模式，整棵子树按 `maxDepth`/`maxNodes` 全展开），`build()` 由 `expanded !== null` 判定展开模式、把 `visit(root, maxDepth, level)` 的 `level` 置真；`visit()` 在展开模式里对每个框都画自己的作用域（`connectScope`），但只有 `node.path ∈ expanded` 才递归子实例，且**不标 `truncated`**（有意为之，不是预算截断）。`GraphPanel` 记 `expanded`（`Set<string>`，`setNode` 时清空，graph 消息带回权威集合），`indexService.graphFor` 透传该选项；webview 收到 `{type:'descendants', path, expanded}` 后增删该路径并重建。webview 里上下级 `+`/`−` 都经 `sideMark()` 画到框缘（带 `lm`/`rm` 类，且在 header 元素之后追加以免先于 chevron 被查到）；左缘按 `up = rootDepth - depth` 判定（见上一条），右缘 `+` 在框未展开时画、`−` 在已展开时画；探测钮隐藏状态由 webview 本地 `probedUp`/`probedDown` 两组路径集合记忆，点过确认无内容后该 `+` 不再画。`core/hierarchy.ts` 的 `subtreeDepth()` 已无消费者，仅保留供外部调用方使用。
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
- **组成树的显示方案已按 §5.4.1 / §5.9 落地**：真顶层为根、默认折叠、第一条分支定位、模板复用、增量反向边库（`parentsOf`/`levelTemplate`）、超大层分片投递，均已实现。具体地：`HdlIndex` 新增增量反向边库（`parentIndex` + `fileEdges` 辅助表、`edgeEpoch`、`parentsOf`），`instantiatorsOf` 改为其薄包装、`resolve.ts` 的 `instancesOf` 走 `parentsOf`（消除全表扫描，O(E) → O(父边数)）；`HierarchyBuilder` 按 module 记忆化 `RowTemplate`（`levelTemplate`），`expandLevel` 改为模板前缀映射；`hierarchy.ts` 新增 `firstParent`/`entryOf`，`containingPath` 由「BFS 最近顶层 / 最短链」改为「第一条分支的真顶层」——多父场景下选根可能与旧实现不同，属**预期语义变化**；`compView.ts` 一层超过 2000 行时按 `children`/`childrenMore` 分片投递，webview 收齐最后一片（`more:false`）才按序整层渲染。**与设计稿的结构差异**：设计稿里单列的 `src/core/hierarchyDb.ts` 未单独建文件——边库直接长在 `HdlIndex` 上、模板库（`levelTemplate`）长在 `HierarchyBuilder` 上，功能等价但更少一层间接；`ChildDesc`/`childIndexOf` 未单独暴露，因为 `ModuleDef.instances` 已是权威的正向事实、`levelTemplate` 就是它的预编译视图，另加一层「按名字索引」会与同名 module 的歧义纠缠；`entryIndex` 未单独缓存，`entryOf` 只在「未材料化时定位」调用、本身 O(深度 × 父边数)，无需缓存。

### 11.3 已知限制

- 无 `code` CLI，尚未在真实 Extension Host 中验收；但 Definition/Hover/Symbols 三个 provider 已由 `providers.test.ts` 在 headless 下跑通（桩 `vscode` 激活扩展 → 扫描 fixture → 逐项调 provider），连接图的渲染与交互已由 `webview.test.ts` 在桩 DOM 上跑通（真实内联脚本 + 真实 `buildGraph`，见 §8）。TreeView 的渲染、semantic token、命令仍只做过静态检查。
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

`GraphPanel` 的力导向布局按**容器组数**分档，并且**不会阻塞 webview 主线程**：

- 力导向跑在**容器框**上而不是单个信号上（一个 module 一个框），组数远小于节点数，同规模的图直接小一个量级。
- 斥力用网格近似：框按 `80*sqrt(g)`（钳制在 150–340）分桶，每个框只与自身及相邻 8 个桶内的框计算斥力。力是 `900/d²`，在 ~130 单位外已小于 0.05；两个框重叠时再加一项与重叠量成正比的推力，所以框不会互相套住。这个近似把每轮的 O(n²) 降到接近 O(n)。
- 迭代轮数随组数递减：`g > 120` 用 60 轮，`g > 40` 用 110 轮，其余 180 轮。
- 每轮之间检查 `Date.now()`，一帧最多算 20ms，剩下的交给 `requestAnimationFrame` 继续；布局未收敛前先画一屏并提示 `laying out N module groups...`，收敛后再整体重绘。
- 初始位置是确定性的径向播种，重合点的抖动也由组序号推导，所以同一张图每次布局结果一致（截图/diff 可复现）。

实测（桩 DOM 里跑真实内联脚本，本机单线程；"框数" = module 容器数，"总计"是全部帧的墙钟时间之和）：

| 节点数 | 边数 | 框数 | 分帧总计 | 帧数 |
|--------|------|------|----------|------|
| 55 | 73 | 11 | 21ms | 1 |
| 200 | 276 | 40 | 48ms | 2 |
| 800（默认上限） | 1116 | 160 | 67ms | 3 |
| 2400（对照，未截断） | 3356 | 480 | 216ms | 8 |

每帧仍 ≤ 20ms：即便拿掉默认节点上限，布局本身也只是多摊几帧，不会冻住 webview；真正控制图规模的仍是 `maxNodes` 截断与 neighbourhood 聚焦。
