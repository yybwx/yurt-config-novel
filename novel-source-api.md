# 小说源接口 v1

## 1. 文件与元数据

每个 JS 文件声明一个继承 `NovelSource` 的类，不自行创建实例。使用 ES class 字段，不依赖浏览器 DOM、`fetch` 或 Node 模块。Yurt 在独立 QuickJS 实例中加载脚本，提供 `Network`、`HtmlDocument`、`Convert` 与受限的运行桥。

```javascript
class ExampleNovelSource extends NovelSource {
    name = '示例小说源';
    key = 'example';
    apiVersion = 1;
    version = '1.0.0';
    minAppVersion = '1.6.3';
    url = 'https://example.com/example.js';
    capabilities = [];
}
```

`key` 必须符合 `[a-zA-Z_][a-zA-Z0-9_]{0,63}`，安装后不应改变。清单中的 `key/type/apiVersion/version/minAppVersion` 与脚本保持一致。当前能力为 `discover` 和 `categories`。版本与最低应用版本为三段数字。

脚本可以实现 `async init()`。持久化使用 `loadData(key)`、`saveData(key, value)`、`deleteData(key)`，仅访问自身小说源数据。不要在源仓库提交 `.data`、账户、Cookie 或全文文件。导入与更新会执行脚本，仅安装可信来源。

## 2. 必需方法

所有方法可返回普通对象或 Promise。失败应抛异常，不返回空正文、错误网页或虚假完整状态。

### 2.1 search(keyword, cursor)

返回 `{books: [...], nextCursor: null, notice: ''}`。书籍字段至少为 `id/title`，可附 `author/cover/description/status/updated/url`；客户端补充 `sourceKey`。不同来源的同名书籍不会自动合并。

### 2.2 loadNovelInfo(novelId)

返回书籍对象，`id` 应与请求一致。ID 使用站点稳定标识，不用标题或临时 URL。简介只保留作品信息，不混入网站下载、广告及控制按钮。

### 2.3 loadCatalog(novelId, cursor)

```javascript
return {
    chapters: [{id: '100', title: '序章', volume: '第一卷', url: 'https://example.com/chapter/100'}],
    complete: false,
    nextCursor: '下一目录页的游标'
};
```

保持源顺序，分卷信息放在每章的 `volume`。排除最新章节预览、广告与错误提示链接。续页必须属于当前书籍，动态签名从当前页面获取，不硬编码。`complete` 明确为布尔值；尚有续页时不得标完整。客户端逐页追加并按章 ID 去重。

### 2.4 loadChapter(novelId, chapterId, cursor)

```javascript
return {
    schemaVersion: 1,
    blocks: [
        {id: '100:1:0', type: 'text', text: '第一段'},
        {id: '100:1:1', type: 'image', url: 'https://example.com/illustration.jpg'}
    ],
    complete: true,
    nextCursor: null,
    hasMissingContent: false,
    notice: ''
};
```

正文按阅读顺序返回段落和插图，纯插图章合法。块 ID 在同一章内唯一，分页时不能重用；相同正文应尽量保持稳定 ID。图片必须是 HTTP(S) 真实地址，优先解析懒加载属性，不能保存占位图地址。正文返回规范化数据，不执行页面脚本、广告或 iframe。

章节内部续页使用 `nextCursor`，不要把下一章当作续页。新版客户端支持可选布尔字段 `hasMissingContent`：正常分页为 false，已经识别正文或插图地址缺失时为 true，并设置 `complete: false` 与缺失提示。客户端跨页保留该状态与提示，不会因末页成功把整章标为完整。字段省略时兼容旧脚本：`complete: false` 且有提示或无续页地址视为缺失；普通分页信息提示应显式提供 false。重试已识别缺失时会从章节首部重新取页，单纯续页中断则从保存的游标继续。截断或加载失败时，即使取得部分文本也应 `complete: false` 并给出 `notice`。无法取得任何正文时抛异常；403/429/登录与浏览器验证也应明确抛错。客户端保留已保存文本，提供重试或结束保留，不把缺正文/缺插图章标为完整下载。

## 3. 可选方法与桥

- `discover(kind, cursor)`：返回与搜索相同的结果结构。约定 `popular/latest/new`；分类为 `category:<id>`。
- `categories()`：返回 `[{id: '1', title: '分类名称'}]`。
- `imageHeaders(url)`：返回请求头对象，可设置 Referer 等。
- `Network.fetchBytes(method, url, headers, data)`：返回 `{status, headers, body, error}`，正文编码使用 `Convert.decodeGbk/decodeUtf8` 等显式转换。
- 请求头 `http_client: 'dart:io'` 可为该源请求选用 Dart 传输；不会修改漫画源的全局网络配置。客户端仍使用应用代理/Cookie，并限制请求超时。
- `HtmlDocument` 使用后必须 `dispose()`。取 `innerHTML`；遍历节点可用 `node.toElement()`，该方法在小说桥中兼容已有的命名差异。

各源有独立 HTML 句柄与存储。桥不允许调用漫画源的 `load_data/save_data/delete_data/load_setting`，也不提供任意文件、剪贴板或 UI 操作。这不是面向不可信脚本的完整安全沙箱。

## 4. 发布验证

更新脚本时同步 `index.json`。源文件及清单通过 GitHub Raw URL 分发，仓库首页不能代替实际文件。

使用 Yurt 的小说源测试验证 GBK 搜索、详情清理、目录续页/卷归属、长章、插图顺序、纯插图章和错误页。真实网站测试需显式开启 `YURT_LIVE_NOVEL_TESTS`，默认自动测试不发外部请求。至少抽查多本书并验证最后一章；下载后禁用源仍应能读取已保存章节。测试通过仅说明当时样本可用，站点变化后须重新验证。

不在源仓库保存测试抓取的小说全文，不声称绕过网站的账户、付费或访问限制。
