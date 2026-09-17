# dsh-autocompact

DeepSeek Harness 通用上下文自动压缩守护插件：对**所有模型、所有 Agent 预设**生效。

## 背景（实测取证，session-e456a8e9，2026-09-17）

- 会话 surface tokens 增长到 1,089,509，转录中 compaction 事件为 **0**；
- 最终请求被上游以 code 11115 拒绝（`prompt is too long: 100001 tokens > 100000 maximum`），
  但 adapter 把它包装成 SERVER/503 → 官方重试循环 116 次 → 会话无响应；
- hy4-preview 声明 contextWindow=1M，真实上游上限 100K → 即使压缩已挂载，按 1M 计算的压力阈值也触发过晚。

## 三层防护

1. **溢出错误分类（宿主平面 llm 缓冲补丁）**：任何 provider 的 stream 失败，
   只要消息命中溢出特征（`prompt is too long` / `context_length_exceeded` /
   `maximum context` / code 11115 等），一律改写为官方 `CONTEXT_WINDOW_EXCEEDED`
   ——这正是官方压缩引擎 `agent/request-error` 监听的错误码，改写后官方
   溢出恢复（压缩 + 重试）自动触发。
2. **真实窗口表**：从上游报错中解析显式上限（如 `> 100000 maximum`），
   按 `provider/model` 持久化；`ctx.llm.resolveModelInfo` 被包裹为返回
   `min(声明值, 真实值)`，压力阈值、token meter 投影、UI 上下文环同步修正。
   已按证据预置 `xuedinerAPI/hy4-preview = 100000`。
3. **压缩组挂载**：扫描 `~/.dsh/.agent-presets/*/agent.cordis.yml`，给缺少
   官方压缩组的预设（如 minimal-grayscale）追加
   `compaction-basic + command-compact + tool-result-pruner`（与官方
   novel-solo/liangshen 预设相同的配置块），注入前生成 `.bak-autocompact` 备份。

## 安装

```sh
dsh plugin --profile desktop add F:/DPH/dsh-autocompact
# 重启 DSH Desktop 后生效
```

## 验证

会话中执行 `/autocompact status`：查看真实窗口表、分类计数、注入结果。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-autocompact
```

卸载不影响已注入预设的压缩组（如需还原，用 `.bak-autocompact` 备份文件）。

## 状态文件

`~/.dsh/dsh-autocompact/state.json`
