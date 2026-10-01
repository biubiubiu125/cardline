# AGENTS.md

本文件约束 `cardline` 仓库里的协作方式，作用域为整个仓库。
用户当前指令优先；更深目录若存在 `AGENTS.md`，则在其范围内补充或覆盖本文件。

## 当前版本

- 当前版本是 `1.0.0`，以根目录 `package.json` 为准；`apps/server/package.json` 与 `apps/web/package.json` 必须与它一致。
- 数据库只使用 PostgreSQL。`SchemaMigration` 的版本号仍是 `1`；`stagedCredential` 与 `refreshHeld` 在这个版本门外面用 `ADD COLUMN IF NOT EXISTS` 补齐，不要为了这两列再插一条版本记录。

## 兑换与找回

- 公开兑换不调用 OpenAI。同一张卡再次兑换只重导出当前库里的凭据，不重新占库存。
- 找回在卡级咨询锁内刷新。新凭据先落库，`refreshHeld` 保持到 HTTP 响应 `finish` 才解除。连接在响应写完前断开时不解除持有，下一次找回不得拿旧 `refresh_token` 再刷新。
- 成功的邮箱交付只有四段或六段，不附带 OpenAI 凭据。同一次批量里，失败卡只能带自己的凭据，不能带上已成功卡的凭据。
- 只有 OpenAI 返回 `invalid_grant` 时，才把账号标成 `invalid`。HTTP 400、401、`invalid_client`、`unauthorized_client` 和地区 403 都不标失效。微软邮箱刷新仍按原错误码处理。
- 当前凭据和暂存都写不进去时，后台刷新结果要带 `unsavedCredential`。公开找回失败可以在响应里给出已换到的凭据，但不能因此解除持有。
