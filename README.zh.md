# dsh-session-menu-delete

[English](README.md) | 中文

在 DSH 侧栏的会话菜单里加一条 **删除会话**：真正删掉持久化会话日志、从 Workspace 注册表移除记账，并让所有已连接客户端立刻丢掉这一行。

DSH 原生只能置顶 / 重命名 / 分叉 / 归档会话——会话日志按设计「只增不删」。这个插件补上删除。

## 安装

```sh
dsh plugin --profile <profile> add dsh-session-menu-delete
```

桌面端在 **设置 → 插件** 里安装即可。插件声明了 `dsh.bundle.patch`，安装本身就会把挂载行写进组合，不用手工改 `cordis.patch.yml`。

## 用法

任意会话行 → 悬停 → 行尾 `…` → **删除会话** → 二次确认。确认后：

- 删除 `<DSH_HOME>/sessions/<项目目录>/session-<id>/`（同项目里其他会话不受影响）
- 从 Workspace 注册表的 `sessionIds` 里摘掉，并清理 pin / archive 状态
- 活会话先 detach 内存 store，再删文件，避免删完又被写回
- 广播 `api-session/removed`，所有客户端列表即时更新，页面随后自动刷新

## 工作原理

| 半侧 | 文件 | 内容 |
| --- | --- | --- |
| host | `lib/index.js` | 注册 `POST /session-delete/exec`；走 `ctx.connection.requestRejection` 准入；删目录、`detachSession` / `unarchiveSession` / `unpinSession`、live detach、发 `api-session/removed` |
| client | `client.js` | 注册 `sidebar.workspaces.session.menu.item`（order 500）与 `shell.overlay` 二次确认框；确认后 POST 并刷新 |

`package.json` 的 `dsh.client`（`platform: web`）与 `exports["./client"]` 让 `dsh-client-modules` 把 `client.js` 作为 `/plugins/dsh-session-menu-delete/client.js` 提供给浏览器，无需额外接线。

### 路由

```http
POST /session-delete/exec
content-type: application/json

{ "sessionId": "session-3c98f71c-5e75-4d87-8274-21fa1ce83cf8" }
```

成功返回：

```json
{ "ok": true, "value": { "sessionId": "…", "root": "…\\.dsh\\sessions", "removed": ["…"], "detachedFrom": ["…"], "live": true, "wasLive": true } }
```

失败返回 `{ "ok": false, "error": "…" }`：400 参数问题、403 未通过准入、405 方法不对、500 文件系统错误。

## 边界

- 会话 id 必须形如 `session-<id>`，作为目录名使用前做白名单校验。
- 只删会话自己的目录；`<项目>` 目录仅在删空时移除。
- 运行中的 Agent 不阻止删除：先 detach 活会话，再删文件。
- **删除不可恢复**；界面里的确认框会写明这一点。
- 不触碰 `.dsh/storages/session_projcache`，刷新后缓存条目自然失效。

## 开发

```sh
# 本地挂载：在 profile 的 cordis.patch.yml 里加
- insert:
    - id: session-delete
      name: dsh-session-menu-delete
```

改完 `client.js` 后刷新一次 GUI 即可（`dsh-client-modules` 按文件元数据派生 rev）。

## License

MIT
