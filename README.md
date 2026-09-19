# dsh-autocompact

DeepSeek Harness 通用上下文自动压缩守护插件：对**所有模型、所有 Agent 预设**生效。

## 背景（实测取证）

一次长会话的取证结论（2026-09）：

- 会话 surface tokens 增长到约 1.09M，转录中 compaction 事件为 **0**；
- 最终请求被上游以 context 超限拒绝（形如 `prompt is too long: N tokens > M maximum`），
  但 provider 把它包装成 SERVER/503 → 官方重试循环上百次 → 会话无响应；
- 某第三方路由声明 contextWindow=1M，真实上游上限 100K → 即使压缩已挂载，按 1M 计算的压力阈值也触发过晚。

## 三层防护

1. **溢出错误分类（宿主平面 llm 缓冲补丁）**：任何 provider 的 stream 失败，
   只要消息命中溢出特征（`prompt is too long` / `context_length_exceeded` /
   `maximum context` / `request_body_too_large` 等），一律改写为官方 `CONTEXT_WINDOW_EXCEEDED`
   ——这正是官方压缩引擎 `agent/request-error` 监听的错误码，改写后官方
   溢出恢复（压缩 + 重试）自动触发。
2. **真实窗口表**：从上游报错中解析显式上限（如 `> 100000 maximum`），
   按 `provider/model` 持久化；`ctx.llm.resolveModelInfo` 被包裹为返回
   `min(声明值, 真实值)`，压力阈值、token meter 投影、UI 上下文环同步修正。
   仓库代码不含任何 provider 预置条目：个人实测值写入用户目录
   `~/.dsh/dsh-autocompact/seeds.json`（不在 git 内），运行时学到的值
   持久化在同目录 `state.json`。
3. **压缩组挂载（显式）**：扫描 `~/.dsh/.agent-presets/*/agent.cordis.yml`。
   **启动只做 dry-run**，不会改用户 yaml。执行 `/autocompact inject` 才会给缺少
   官方压缩组的预设追加 `compaction-basic + command-compact + tool-result-pruner`，
   注入前生成 `.bak-autocompact` 备份。`@deepseek-ai/dsh-llm` 是 peer，不要装进插件目录。

## 安装

从 GitHub（推荐）：

```sh
dsh plugin --profile desktop add github:xuediner-source/dsh-autocompact
# 重启 DSH Desktop 后生效
```

或从本地目录：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-autocompact
# 重启 DSH Desktop 后生效
```

## 验证

会话中执行 `/autocompact` 或 `/autocompact status`：查看真实窗口表、分类计数、待注入预设。
确认后执行 `/autocompact inject` 才会写盘。`npm test` 覆盖溢出分类。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-autocompact
```

卸载不影响已注入预设的压缩组（如需还原，用 `.bak-autocompact` 备份文件）。

## 状态文件（用户目录，不在 git 内）

- `~/.dsh/dsh-autocompact/state.json` —— 运行时学到的窗口表与计数
- `~/.dsh/dsh-autocompact/seeds.json` —— 个人预置窗口（手工维护，格式同 state 的 windows 字段）
