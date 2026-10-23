# RTLens

一个用于阅读 **Verilog / SystemVerilog** 的 VS Code 插件：语法高亮、信号 / module 跳转、可视化的连接关系图、层次组成树，以及由实例生成包装 module（wrapper）。

> [!IMPORTANT]
> **本插件主要由 AI 生成。**
> 代码、语法定义、测试与文档绝大部分由一个 AI 编程助手（opencode）在人类指导下迭代产出，人类负责提出需求、评审与验收。AI 生成的代码可能包含错误或不完整之处，**在用于生产 / 流片流程之前请自行审计**。设计与实现细节见仓库中的 `DESIGN.md`。

---

## 功能

- **语法高亮**：自带的 TextMate 语法（`syntaxes/`），覆盖 Verilog-1995 / 2001 与 SystemVerilog；另有语言配置（注释、括号、折叠、缩进）。可选**语义高亮**：按语义分析区分 module 类型、实例名、端口、信号、参数、函数、genvar、typedef / 类型名等。
- **跳转与导航**：定义跳转（Go to Definition）、引用（Find References）、重命名（Rename）、悬停（Hover）、文档符号（Document Symbols），基于**全工作区索引 + 层次化名字解析**，跨文件、跨 generate / 块作用域均可解析。
- **信号 / 模块追踪**：光标放在信号、端口或模块/实例名上，`F3` 向顶层逐跳追踪，`F4` 向叶子逐跳追踪，自动按光标内容分派。**信号**：`F3` 信号的使用处先到本模块的声明处，端口声明处再跨到上级模块里例化本模块的实例；`F4` 分两步，先在当前模块内落到连着该信号的子实例连接处，再进入子模块的端口声明；到最底层（叶子端口，或没有子实例连着的信号）时最后一跳落在该模块体里信号被使用的位置。**模块**：`F3` 向上逐级走，每一级有两个位置——module 的**实现位置**（它的定义名）和**它被例化的位置**（父文件里那条例化），一跳一个位置、依次经过：光标在 module 定义名上时跳到**它被例化的位置**（被多处例化时列表选择），光标在例化处（实例名、例化语句里的模块类型名，或连接列表里连着的信号——这些位置都算**被例化的 module**，不算当前 module）时跳到**包含它的那一级 module 的实现位置**，再按一次 `F3` 就从那里跳到**那一级 module 被例化的位置**；一路到顶层，顶层无人例化时无目标。`F4` 逐级向下走，每一级同样有两个位置——子 module 的**例化位置**（当前文件里那条例化）和它的**实现位置**（定义处），一跳一个位置、依次经过：光标停在别处（module 定义名、空行、空白处等）时，候选是**当前所在 module 的子模块**，跳到**它被例化的位置**（当前文件里那条例化；有多个子模块时列出让你选）；光标停在例化处（实例名、例化语句里的模块类型名，或连接列表里连着的信号）时，那一个实例只指向一个 module，直接跳到**被例化 module 的实现文件**（它的定义处），不弹列表；于是一条向下的链是「当前 module 的实现位置 → 子 module 的例化位置 → 子 module 的实现位置 → 孙 module 的例化位置 → …」，每一级都看得见它的例化点和它的实现；当前 module 是个**叶子 module**（一个子模块都没有）时，改为跳到**该 module 自己的定义处**。每次只跨一跳，结果唯一时直接跳到对应位置，有多个目标时弹出列表选择，可从落点继续追踪，连按即可走到顶 / 到底。
- **全局搜索 module**：复用 VS Code 原生的「Go to Symbol in Workspace」（`Ctrl+T` / macOS `Cmd+T`，即命令面板的 `#` 前缀输入框），全工作区每个 module 定义都会出现在该框里，可按名字或文件路径模糊搜索（空格分隔多词、逐词子序列匹配），确定后跳到实现文件并把光标落在 module 名上。每处定义各占一行，因此同名 module（如 RTL 与黑盒 stub）也能按路径区分。命令面板里的 `HDL: Go to Module` 也直接调起同一个系统框。
- **连接关系图**：SVG 交互式 webview。一个 module 一个容器框、信号是框内的行，边表示端口连接与网络。默认按层次分列布局（可切换力导向），支持缩放 / 平移 / 拖拽、按信号搜索（顶部全局搜索，以及**每个 module 框 header 内的搜索框**（居中放在实例名与 module 名之间；输入后按 Enter 才开始搜索，范围只限本框自己的信号（含未接到下级端口的内部信号）与它的直接子模块：原有画面保持不变，只把匹配到的框/信号行新增进来并高亮——不整组带出，搜一个模块名不会把它的全部信号行都拉进来，也不下钻孙辈，同时自动展开被分页或信号上限藏起来的匹配））、只看选中子树、折叠信号行与子树，以及沿实例层级上下钻取。
- **拓扑图（Topology）**：把一个 module 画成一张三列示意图——**输入端口在最左、它例化的子模块在中间、输出端口在最右**，连线全部按**网络身份**推导而不是按源码顺序：`input → 实例`、`实例 → output`、`input → output` 直通、`实例 → 实例` 都由同一次网络遍历得出，`assign` 只是缓冲（两侧同名）时画实线，跨过 `assign` 的表达式（如三目）画虚线并在中点标出右侧表达式，因此 `assign carry = dp_carry;` 是一条直连、而 `assign result = sel ? a : b;` 能看出结果来自哪个选择。**跳转**：左上角面包屑可回到任意上级 module 和设计顶层，点任意子模块框进入它的图，点标题打开当前 module 源码——面板内原地跳转，导出的文件里则变成 `vscode://file/...` 链接。**颜色**：输入信号统一一色、输出信号统一另一色，每个不同的子模块一种颜色（同一 module 的两个实例同色），深浅主题各一套。**信号显示**：可切换 `Signals`（全部列出）、`Hide`（只留子模块框，信号名收缩到两侧边栏）、`Bundle`（按方向合并：`inputs`、`inout`、`outputs` 各一根总线，子模块框内按 in/out/inout 各合成一根线，**每两根合并线之间只画一根带箭头的线**——帧的总线到每个子模块、每个子模块到帧的总线、两个子模块之间都只有一根，端口名收进 tooltip）。**箭头**：每根线尾都带一个方向箭头，线尾停在目标表面上（子模块框的边框、输出总线的挂条边），所以箭头露在图形外面、不会被框或总线盖住。**当前模块的边界框**：整张图只有一个圆角实线框——它画出当前 module 自己的边界，左边框切在输入框的正中间、右边框切在输出框的正中间，于是输入/输出的框被边界线切一半、端口像挂在模块边上，子模块都画在这个框里，框的上下还各留出一点空白（不贴着端口和子模块）；叶子 module（没有子模块）也有这个框。**两种生成**：右键 `HDL: Generate Topology SVG (Current Module)` 生成当前 module 的单张自包含 SVG；`HDL: Generate Topology SVGs (Current Module + Submodules)` 按层次为每个 module 实例各生成一张、用相对文件名互相链接（同一 module 的不同实例各得一张，文件名按实例路径去重）。生成受 `hdl.connectView.topology.maxDepth`（`0` = 不限）与 `topology.filterModules`（被过滤的 module 不生成、其整棵子树也不生成）控制。导出的 SVG **不含脚本**，可直接放进 wiki / issue / 文档。
- **组成树（Composition）**：侧边栏 webview，展示 module 之间的例化关系，可跳转到源码。根固定在整个设计上：设置了 `hdl.connectView.topModules` 就从该顶层 module 展开，未设置则自动向上找到包含**当前所在 module** 的设计顶层。切换文件时**树不搬家**（只有换到另一份设计才重建），而是**自动定位并高亮**当前文件对应的 module 行——展开沿途、滚动到它并加高亮，可在整个设计里随时看清自己编辑的 module 处在什么位置；打开或切换文件定位时，除目标路径外的其他分支会自动折叠（同一文件内移动光标不影响手动展开的层次）。层次的深度与实例数由**独立的** `hdl.connectView.composition.maxDepth` / `composition.maxInstances` 控制，默认都为 `0`（不限制），与连接图等使用的全局 `maxDepth` / `maxInstances` 互不影响。**层次化显示 + 逐级展开/折叠**：每行带缩进与折叠三角，每一级默认**折叠**，点三角逐级展开/折叠，可一直展开到叶子 module；下级一次性全部列出，不分页。**标题栏全局展开/折叠**：视图右上角的按钮一按即把整棵例化树全部展开或全部折回根部，图标会随当前状态自动在 `Expand all` / `Collapse all` 之间切换（原来占这个位置的 `Show Connectivity Graph` 按钮移到了该视图的行内右键菜单与命令面板）。**刷新索引**：新增（或改动）module 及其子层次后，点视图标题栏的刷新按钮重扫工作区，组成树会**从最新索引重建**并把新增的层次（含子层）显示出来。**模块过滤**：用 `hdl.connectView.composition.filterModules` 填要过滤的条目、`composition.filterMode` 选模式——条目可以是 **module 名**（按被例化的 module 名匹配，名字优先）、**文件路径**（过滤该文件里定义的所有 module）或**目录路径**（过滤其下递归定义的所有 module），相对路径按每个 workspace folder 解析、绝对路径原样使用；模式 `1` 保留被过滤 module 的实例行、只隐藏它下面的子模块（当叶子显示并标 `filtered`）；模式 `2`（默认）连实例行及整棵子树一起隐藏，改这个设置在**当前屏幕上立即生效、不需要重扫工作区**，被隐藏的子树也**不会被展开**、因此不占用 `composition.maxInstances` 的实例预算。**搜索**：顶部输入框对实例名 / module 名做模糊（子序列）匹配并高亮命中字母，查询可用空格分隔多个词（每个词各作子序列匹配、全部命中才算命中，如 `u mid` 命中 `u_mid`），只保留命中行及其祖先并自动展开这条路径，清空即恢复整棵树——与 Nets 视图同一套搜索。**按需懒加载**：整棵树不再一次性建好再传给界面，而是**打开哪一层才建哪一层**——只发根行，点开某个层级时后台只材料化这一层并把它的子行补进来。这样即便层次默认不限深、不限实例（几万、几十万节点），初始视图也只是一行、光标移动只更新高亮而不重建，编辑器里再加 module 也不会因为一次编辑就重发整棵树。注意搜索此时只覆盖**已经展开**的层级（没打开的层还没有行）。
- **Net 视图与问题视图**：列出网络与解析过程中的告警（未声明信号、缺失 module、被丢弃的 typedef 等）。
- **包装 module 生成**：从图中或光标处的实例生成 wrapper 源码，支持四种模式 —— `Auto`、`Flatten`（内联展开）、`Compose`（保留实例、重建接线）、`Stub`（例化并原样引出端口）。生成结果先预览，写盘需要显式 "Save As" 确认。
- **分类数据库**：把设计固化成一组可落盘、可 diff 的 JSON，按职责分类放在每个工作区 `.vscode/rtlens/` 下——`index.json`（模块定义 + 例化边）、`hierarchy/`（v4 层次库：`current.json` manifest + 256 个按 module 名哈希的分片，组成树按需读取）、`graph.json`（各顶层默认连通图）、`relations.json`（信号读写 + module 间端口连接）。支持增量（只重算变动文件及其依赖）与全量刷新，由底部状态栏一个 `RTLens DB` 按钮一键更新；关闭自动更新时仅手动刷新或文件集合相关设置变化才重建。`index.json` / `graph.json` 是 artifact（可检视，不接线回读）。激活时不扫描、也不预读层次库；首次索引就绪后才校验指纹并读取 manifest，组成树首屏只加载根及其直接子级。

## 视图

活动栏中的 **RTLens** 容器包含三个视图：

| 视图 | 说明 |
|------|------|
| Composition | module 层次组成树（自动定位并高亮当前 module、可展开/折叠、可模糊搜索） |
| Nets | 网络列表（信号/端口）；支持在侧边栏内直接模糊搜索（查询可用空格分隔多个词，逐词子序列匹配、全部命中才显示） |
| Problems | 索引 / 解析告警 |

## 命令

| 命令 | 说明 |
|------|------|
| `HDL: Refresh Index` | 重建工作区索引 |

| `HDL: Refresh Signal/Module Database` | 刷新分类数据库（`.vscode/rtlens/` 下的 `index.json` / `hierarchy/` / `graph.json` / `relations.json`），支持增量或全量 |
| `HDL: Show Connectivity Graph` | 打开选中实例的连接关系图 |
| `HDL: Expand All in Composition` | 展开组成树的全部层次（组成视图标题栏按钮） |
| `HDL: Collapse All in Composition` | 折叠组成树的全部层次（组成视图标题栏按钮） |
| `HDL: Show Connectivity Graph for Current Module` | 打开光标所在 module 的图（快捷键 `Ctrl+Alt+G` / macOS `Cmd+Alt+G`） |
| `HDL: Show Module Topology` | 打开光标所在 module 的拓扑图面板（三列示意图，可逐级上下钻取） |
| `HDL: Generate Topology SVG (Current Module)` | 把当前 module 的拓扑图导出为一张自包含 SVG（子模块框链到定义处） |
| `HDL: Generate Topology SVGs (Current Module + Submodules)` | 按层次为当前 module 及所有下级 module 各导出一张 SVG，互相用相对文件名链接 |
| `HDL: Set Graph Root to Current Module` | 把图根设为当前 module |
| `HDL: Generate Wrapper Module for Instance` | 由实例生成包装 module |
| `HDL: Trace Up (signal or module)` | 从光标处的信号或模块向顶层逐跳追踪（快捷键 `F3`） |
| `HDL: Trace Down (signal or module)` | 从光标处的信号或模块向叶子逐跳追踪（快捷键 `F4`） |
| `HDL: Reveal Current Module in Composition Tree` | 在组成树中定位当前 module |
| `HDL: Copy Hierarchical Path of Current Instance` | 复制当前实例的层次路径 |
| `HDL: Go to Module` | 调起系统「Go to Symbol in Workspace」框（`Ctrl+T` / macOS `Cmd+T`），全工作区 module 可模糊搜索并跳到实现文件 |

## 设置

| 设置 | 默认值 | 说明 |
|------|--------|------|
| `hdl.connectView.files` | `["**/*.{v,sv,svh,vh,vlt}"]` | 参与索引的文件 glob（相对各工作区文件夹） |
| `hdl.connectView.includeDirs` | `["include","inc","../include","../inc"]` | 查找 `` `include `` 的额外目录 |
| `hdl.connectView.exclude` | `["**/tb/**","**/testbench/**","**/*_tb.v","**/*_tb.sv","**/build/**","**/output/**"]` | 排除的 glob；默认排除 testbench，因为它们通常是层次树的叶子 |
| `hdl.connectView.topModules` | `[]` | 显式顶层 module 名；为空时自动推断（从未被例化的 module）。设置后组成树从该顶层展开整个设计；为空则从当前所在 module 开始 |
| `hdl.connectView.maxDepth` | `32` | 层次展开的最大深度（防止递归 generate 死循环）。作用于连接图、wrapper 等全局层次 |
| `hdl.connectView.maxInstances` | `20000` | 单次展开实例化的层次节点上限 |
| `hdl.connectView.composition.maxDepth` | `0` | 组成树（左侧层次）自己的展开最大深度，独立于 `maxDepth`；`0` = 不限制（自例化的递归 module 仍由环检测拦下） |
| `hdl.connectView.composition.maxInstances` | `0` | 组成树单次展开的实例行上限，独立于 `maxInstances`；`0` = 不限制 |
| `hdl.connectView.composition.filterModules` | `[]` | 要从组成树里过滤掉的条目：module 名（优先）、文件路径（该文件内定义的所有 module）或目录路径（其下递归定义的所有 module）；相对路径按 workspace folder 解析，绝对路径原样使用；配合 `composition.filterMode` 决定隐藏范围 |
| `hdl.connectView.composition.filterMode` | `2` | 过滤模式：`1` = 保留被过滤 module 的实例行、只隐藏它下面的子模块（实例当叶子并标 `filtered`）；`2` = 连实例行及其整棵子树一起隐藏（默认，过滤后整行消失） |
| `hdl.connectView.topology.maxDepth` | `0` | 批量导出拓扑 SVG 时的层次深度（当前 module 为 0 层）；`0` = 不限，自例化的递归 module 由环检测拦下 |
| `hdl.connectView.topology.filterModules` | `[]` | 拓扑图与导出里要跳过的条目：module 名（优先）、文件路径（该文件内定义的所有 module）或目录路径（其下递归定义的所有 module）；相对路径按 workspace folder 解析，绝对路径原样使用。被过滤的 module 不画框、也不生成它的 SVG，其子树同样不生成 |
| `hdl.connectView.topology.signalMode` | `all` | 拓扑图默认的信号显示：`all` 全部列出、`hidden` 只留子模块框、`bundled` 按方向合并成 `inputs` / `inout` / `outputs` 各一根总线，子模块按 in/out/inout 合并且每两根合并线之间只画一根线 |
| `hdl.connectView.graph.maxNodes` | `800` | 连接图渲染的节点上限，超出后退化为邻域视图 |
| `hdl.connectView.graph.showContainment` | `false` | 在连接图中显示父子包含边 |
| `hdl.connectView.graph.maxSignalsPerGroup` | `40` | 每框信号行上限；按顺序先留实例端口连线、再 `assign` 两端、最后端口声明，超出的收进 `...`（点击逐页放开，设 `0` 全部显示） |
| `hdl.connectView.defaultChildLimit` | `40` | 连接图里每个 module 框一页画出的下级子框数：超出后框内出现一行 `more children`，点击补一页下级并顺带放行一页节点预算（与信号 `...` 行各自独立）。组合树不分页，靠展开/折叠 |
| `hdl.connectView.followDefinition` | `true` | 在实例名上按 F12 跳到其 module 定义；关闭则在组成树中定位 |
| `hdl.connectView.enableSemanticHighlighting` | `true` | 启用语义高亮（实例名、端口名、声明信号等） |
| `hdl.connectView.databasePaths` | `[]` | 额外参与索引与数据库的路径或文件；相对路径按各工作区文件夹解析，绝对路径原样使用。目录按 `files` 递归扫描，文件直接索引 |
| `hdl.connectView.databasePathsOnly` | `false` | 勾选后只扫描 `databasePaths` 指定的路径与文件，跳过当前打开的工作区；不勾选则在配置项之外同时扫描工作区 |
| `hdl.connectView.autoUpdateDatabase` | `true` | 索引文件改动时自动增量更新分类数据库（`.vscode/rtlens/` 下的 `index.json` / `hierarchy/` / `graph.json` / `relations.json`）；关闭后仅由手动刷新命令、或 `files` / `includeDirs` / `exclude` / `databasePaths` / `databasePathsOnly` 变化时重建 |

## 快速开始

1. 用 VS Code 打开包含 `.v` / `.sv` 源文件的工作区。扩展在打开 HDL 文件时激活；打开文件只解析该文件供大纲使用，工作区索引等到首次跨文件功能（定义 / 悬停 / 引用 / Nets / 组成树 / 问题）才建立，不在启动时扫描整个工作区。组成视图隐藏时只记住当前文件与光标，不解析缓冲区；点开视图后才解析并定位到当前 module。
2. 在编辑器中把光标放到某个 module 或实例上，按 `Ctrl+Alt+G` 打开连接关系图。
3. 或在 **Composition** 视图里点击某行跳到源码，再用命令面板的 `HDL: Show Connectivity Graph` / `HDL: Generate Wrapper Module`。
4. 若默认排除规则不适用，调整 `hdl.connectView.files` / `hdl.connectView.exclude` 后执行 `HDL: Refresh Index`。
5. 分类数据库保存在工作区的 `.vscode/rtlens/`（`index.json` / `hierarchy/` / `graph.json` / `relations.json`），底部状态栏的 `RTLens DB` 按钮可手动刷新（增量或全量）。默认（`hdl.connectView.autoUpdateDatabase` 开启）会在索引文件改动后自动增量更新；激活时不扫描、不预读，首次索引就绪后才校验指纹并读取层次库，且只读不写。关闭该设置后，只有手动刷新、或文件集合相关配置（`files` / `includeDirs` / `exclude` / `databasePaths` / `databasePathsOnly`）变化时才会重建。

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
