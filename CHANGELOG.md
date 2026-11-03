# Changelog

## 1.0.1

- 文档：说明在 DSH 0.2.1-rc.3 上浏览器看板不渲染（typert 契约版本不同），工具不受影响。

## 1.0.0

从 hyperMoss/dsh-diary v0.1.1 分叉，加入家庭权限与可部署性修复。

- 接入 dsh-family-auth：日记按成员分目录存（`<root>/<成员id>/`），读不到的会话拿不到数据，不回退成全部可见。
- `_pending/` 待认领区：认不出说话人的日记只有户主可见，`diary_claim` 把它交给真正的成员（真移动文件，不覆盖已有）。
- 同一天两人都写了不再静默合并：`diary_read/update/delete` 必须带 `owner`，列表每行标出归属。
- 模板仍由全家共用；`identity: auth` 而没有 dsh-family-auth 时拒绝写入而不是猜。
- 面板是操作台不是隔离：`panel: all|pending|off`，README 里写明了这一点。
- 修复：typert manifest 注册冲突不再让整个插件激活失败（上游需要 bin/patch-diary.sh 打补丁）。
- 构建：devDependencies 改成已发布的 @deepseek-ai 包，全新克隆能装能构建。

