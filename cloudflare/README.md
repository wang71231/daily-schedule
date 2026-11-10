# Cloudflare 托管部署

目标是 Workers 提供带登录的网页和接口，D1 持久保存课时。运行不依赖家里服务器。当前配置里的全零数据库 ID 是占位，**不代表已经上线**。

工具版本锁定在 `package-lock.json`；不要顺手升级系统 Node、Python 或现有工具。

## 首次部署

在项目目录执行。只使用已有账户；如果平台要求开通收费计划，请先停止确认费用。

```sh
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 list
```

若已有对应数据库，核对用途后复用。否则：

```sh
npx wrangler d1 create daily-schedule
```

将返回的真实 `database_id` 填入 `wrangler.jsonc`，保持名称和 `binding: DB`。数据库 ID 不是密码；不能把令牌写入这个文件。

```sh
npx wrangler d1 execute daily-schedule --remote --file cloudflare/schema.sql
python cloudflare/set_password.py
npm run deploy
```

`set_password.py` 交互读取新站密码，生成适合 Worker 的 PBKDF2 哈希，通过标准输入写入 Worker secret，不将明文或哈希写入 Git。默认密码长度 6–128 字符。旧 Python 服务用的是 240000 次哈希，不能直接当作 Worker 的初始值；此部署使用 100000 次及登录限速。

**不要将 `.dev.vars` 的测试密码用于公网。** 正式密码通过 `wrangler secret put` 单独配置；之后网页修改的密码保存在 D1，优先于初始化 secret。

先使用部署命令返回的 `workers.dev` HTTPS 地址验收：

1. 未登录的 API 返回 401，课表页跳到登录页。
2. 登录、补录、刷新、另一设备登录读取、改密后原会话失效。
3. 手机导入真实 JSON 后核对条数、课时和工资，确认显示“已同步”。
4. 点击“云端保存历史”，确认可下载前一版本。

之后再将 `kb.renhao.eu.cc` 绑定到 Worker 的自定义域。原域名有 Tunnel DNS 记录，需在 Cloudflare 控制台核对并替换；不要删除同域的网盘等其他记录。域名切换前备份新 D1，保留旧记录及 JSON 回退文件。

## D1 备份

```sh
npx wrangler d1 export daily-schedule --remote --output=/你的私有备份目录/daily-schedule.sql
```

完整 SQL 备份含密码哈希与会话，必须保存到仓库外。页面下载的课时 JSON 只包含业务数据，也不要提交公开仓库。服务端保留所有已接受版本；界面列出最新 100 个，不会自动删除更早的历史。另需关注 D1 使用量和备份策略；平台免费额度及恢复保留期限以账户控制台为准。

## 本地联调

使用独立的测试数据库；不要复制生产数据库到测试用例中。

```sh
npx wrangler d1 execute daily-schedule --local --file cloudflare/schema.sql --persist-to /私有目录/test-d1
python cloudflare/set_password.py --local-test
npx wrangler dev --local --port 18788 --persist-to /私有目录/test-d1
python tests/test_hosted.py
```

测试网址为 `http://localhost:18788`。不要为了测试而删除 Origin 或 CSRF 检查。登录页使用 `Referrer-Policy: same-origin`，让浏览器表单提交保留同源 Origin；`no-referrer` 可能使表单发送 `Origin: null` 而被拒绝。

本地测试密码是固定的 `isolated-local-test-only`，仅配合 `--local-test` 使用。测试数据库和本机历史中可能保留测试记录，应与生产完全隔离。

## 故障与回退

- 本机有记录但云端空：先下载本机 JSON，再点击页面提供的“上传本机记录”，不可直接清空浏览器。
- 来源 ID 变化或云端版本倒退：自动暂停，不静默覆盖；备份两端后核对。
- 同一记录冲突：页面提供双方备份和选择，不按最后到达的请求直接覆盖。
- 新服务故障：保留本机 JSON 和 D1 导出。可回退 Worker 代码版本；数据库不随代码发布重建。
- 旧版页面仅支持本机存储，可作为查看和导出入口。回退到旧代码不能自动读取新版 IndexedDB，须先在新版导出 JSON。
