# RTLens

一个用于阅读 **Verilog / SystemVerilog** 的 VS Code 插件：语法高亮、信号 / module 跳转、可视化的连接关系图、层次组成树，以及由实例生成包装 module（wrapper）。

> [!IMPORTANT]
> **本插件主要由 AI 生成。**
> 代码、语法定义、测试与文档绝大部分由一个 AI 编程助手（opencode）在人类指导下迭代产出，人类负责提出需求、评审与验收。AI 生成的代码可能包含错误或不完整之处，**在用于生产 / 流片流程之前请自行审计**。设计与实现细节见仓库中的 `DESIGN.md`。

---

## 功能

- **语法高亮**：自带的 TextMate 语法（`syntaxes/`），覆盖 Verilog-1995 / 2001 与 SystemVerilog；另有语言配置（注释、括号、折叠、缩进）。可选**语义高亮**：按语义分析区分 module 类型、实例名、端口、信号、参数、函数、genvar、typedef / 类型名等。
- **跳转与导航**：定义跳转（Go to Definition）、引用（Find References）、重命名（Rename）、悬停（Hover）、文档符号（Document Symbols），基于**全工作区索引 + 层次化名字解析**，跨文件、跨 generate / 块作用域均可解析。
- **信号追踪**：光标放在信号或端口上，`Ctrl+Alt+U` 向上追踪驱动源（fan-in）、`Ctrl+Alt+D` 向下追踪负载（fan-out）。每次只跨一跳 —— 赋值两端、子实例端口、以及端口到父实例的连线；结果唯一时直接跳到对应位置，有多个目标时弹出列表选择，可从落点继续追踪。
- **连接关系图**：SVG 交互式 webview。一个 module 一个容器框、信号是框内的行，边表示端口连接与网络。默认按层次分列布局（可切换力导向），支持缩放 / 平移 / 拖拽、按信号搜索（顶部全局搜索，以及**每个 module 框 header 内的搜索框**（居中放在实例名与 module 名之间；输入后按 Enter 才开始搜索，范围只限本框自己的信号（含未接到下级端口的内部信号）与它的直接子模块：原有画面保持不变，只把匹配到的框/信号行新增进来并高亮——不整组带出，搜一个模块名不会把它的全部信号行都拉进来，也不下钻孙辈，同时自动展开被分页或信号上限藏起来的匹配））、只看选中子树、折叠信号行与子树，以及沿实例层级上下钻取。
- **组成树（Composition）**：侧边栏层次树，展示 module 之间的例化关系，带层次路径面包屑，可跳转到源码。
- **Net 视图与问题视图**：列出网络与解析过程中的告警（未声明信号、缺失 module、被丢弃的 typedef 等）。
- **包装 module 生成**：从图中或光标处的实例生成 wrapper 源码，支持四种模式 —— `Auto`、`Flatten`（内联展开）、`Compose`（保留实例、重建接线）、`Stub`（例化并原样引出端口）。生成结果先预览，写盘需要显式 "Save As" 确认。
- **信号 / module 关系数据库**：将信号读写关系与 module 间端口连接固化为 JSON 文件，保存到每个工作区 `.vscode/rtlens/relations.json`，支持增量（只重算变动文件及其依赖）与全量刷新，可通过底部状态栏按钮一键更新。

## 视图

活动栏中的 **RTLens** 容器包含三个视图：

| 视图 | 说明 |
|------|------|
| Composition | module 层次组成树 |
| Nets | 网络列表 |
| Problems | 索引 / 解析告警 |

## 命令

| 命令 | 说明 |
|------|------|
| `HDL: Refresh Index` | 重建工作区索引 |
| `HDL: Refresh Signal/Module Database` | 刷新信号/module 关系数据库（.vscode/rtlens/relations.json），支持增量或全量 |
| `HDL: Show Connectivity Graph` | 打开选中实例的连接关系图 |
| `HDL: Show Connectivity Graph for Current Module` | 打开光标所在 module 的图（快捷键 `Ctrl+Alt+G` / macOS `Cmd+Alt+G`） |
| `HDL: Set Graph Root to Current Module` | 把图根设为当前 module |
| `HDL: Generate Wrapper Module for Instance` | 由实例生成包装 module |
| `HDL: Trace Signal Up (drivers)` | 从光标处的信号向上追踪驱动源（快捷键 `Ctrl+Alt+U` / macOS `Cmd+Alt+U`） |
| `HDL: Trace Signal Down (loads)` | 从光标处的信号向下追踪负载（快捷键 `Ctrl+Alt+D` / macOS `Cmd+Alt+D`） |
| `HDL: Reveal Current Module in Composition Tree` | 在组成树中定位当前 module |
| `HDL: Copy Hierarchical Path of Current Instance` | 复制当前实例的层次路径 |

## 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `hdl.connectView.files` | `["**/*.{v,sv,svh,vh,vlt}"]` | 参与索引的文件 glob（相对各工作区文件夹） |
| `hdl.connectView.includeDirs` | `["include","inc","../include","../inc"]` | 查找 `` `include `` 的额外目录 |
| `hdl.connectView.exclude` | `["**/tb/**","**/testbench/**","**/*_tb.v","**/*_tb.sv","**/build/**","**/output/**"]` | 排除的 glob；默认排除 testbench，因为它们通常是层次树的叶子 |
| `hdl.connectView.topModules` | `[]` | 显式顶层 module 名；为空时自动推断（从未被例化的 module） |
| `hdl.connectView.maxDepth` | `32` | 层次展开的最大深度（防止递归 generate 死循环） |
| `hdl.connectView.maxInstances` | `20000` | 单次展开实例化的层次节点上限 |
| `hdl.connectView.graph.maxNodes` | `800` | 连接图渲染的节点上限，超出后退化为邻域视图 |
| `hdl.connectView.graph.showContainment` | `false` | 在连接图中显示父子包含边 |
| `hdl.connectView.graph.maxSignalsPerGroup` | `40` | 每框信号行上限；按顺序先留实例端口连线、再 `assign` 两端、最后端口声明，超出的收进 `...`（点击逐页放开，设 `0` 全部显示） |
| `hdl.connectView.defaultChildLimit` | `40` | 单页带出的下级子框数：组合树首屏只画一页、尾部一行 `show N more children` 点击加载下一页；连接图里右缘 `+` 揭示下级时也只画一页，框内另有一行 `more children`，点击补一页下级并顺带放行一页节点预算（与信号 `...` 行各自独立） |
| `hdl.connectView.followDefinition` | `true` | 在实例名上按 F12 跳到其 module 定义；关闭则在组成树中定位 |
| `hdl.connectView.enableSemanticHighlighting` | `true` | 启用语义高亮（实例名、端口名、声明信号等） |
| `hdl.connectView.databasePaths` | `[]` | 额外参与索引与数据库的路径或文件；相对路径按各工作区文件夹解析，绝对路径原样使用。目录按 `files` 递归扫描，文件直接索引 |
| `hdl.connectView.databasePathsOnly` | `false` | 勾选后只扫描 `databasePaths` 指定的路径与文件，跳过当前打开的工作区；不勾选则在配置项之外同时扫描工作区 |

## 快速开始

1. 用 VS Code 打开包含 `.v` / `.sv` 源文件的工作区，扩展会自动激活并建立索引。
2. 在编辑器中把光标放到某个 module 或实例上，按 `Ctrl+Alt+G` 打开连接关系图。
3. 或在 **Composition** 视图里右键实例，选择 *Show Connectivity Graph* / *Generate Wrapper Module*。
4. 若默认排除规则不适用，调整 `hdl.connectView.files` / `hdl.connectView.exclude` 后执行 `HDL: Refresh Index`。
5. 信号/module 关系数据库保存在工作区的 `.vscode/rtlens/relations.json`，底部状态栏的 `RTLens DB` 按钮可手动刷新（增量或全量）；激活时只读取，不自动重写。

## 开发

需要 Node.js 与 npm。打包使用 `@vscode/vsce`（通过 `npx` 按需获取，不写入依赖）。

```bash
npm install
npm run compile     # tsc -p ./
npm test            # 编译 + 单元测试（node --test out/test/）
npm run check       # 编译 + 单元测试 + fixture 端到端检查
npm run package     # vsce package
```

或使用 Makefile（`make` 默认目标 = 编译 + 测试 + 打包）：

```bash
make            # 编译 + 测试 + e2e + 打包到 dist/rtlens-<version>.vsix
make check      # 编译 + 单测 + e2e
make install    # 打包并安装到本地 VS Code（需要 PATH 上有 code）
make help       # 列出所有目标
```

离线环境可用本地 vsce：`make vsix VSCE=./node_modules/.bin/vsce`。

### 项目结构

```
src/
  core/       # 与 vscode 无关的纯函数：lexer / parser / ast / resolve / graph / generator / hierarchy …
  vscode/     # 扩展宿主层：indexService / providers / graphPanel / generate / views / config
  test/       # 单元测试（大部分不依赖 vscode；需要时用 vscodeStub 桩）
  tools/e2e.ts# 基于 test/fixtures 的端到端检查
syntaxes/     # TextMate 语法
resources/    # 图标（活动栏单色蒙版 SVG + marketplace 彩色 PNG）
test/fixtures # 端到端测试用的 Verilog/SystemVerilog 例程
```

设计原则：**零原生依赖**（不引入需要 node-gyp 的模块）、**Webview 资源随包分发**（不依赖 CDN，可离线使用）、**容错优先**（解析器永不抛异常，遇到不认识的语法就跳过，保证半成品文件下索引仍可用）。

## 已知限制 / 非目标（v0.1）

- 不做完整的 IEEE 1800 语义仿真、类型检查、时序检查。
- 宏（`` `define ``）只做有限展开，`` `ifdef `` 内的死代码不做符号剔除。
- 不解析 UVM class / constrained random 的对象图（可识别但不展开）。
- 不调用外部编译器（iverilog / verilator 等）。

## License

MIT（见 `package.json`）。
