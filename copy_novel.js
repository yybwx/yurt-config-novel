class CopyNovelSource extends NovelSource {
    name = '拷贝轻小说';
    key = 'copy_novel';
    version = '1.0.0';
    url = 'https://raw.githubusercontent.com/yybwx/yurt-config-novel/main/copy_novel.js';
    capabilities = ['discover', 'categories'];
    base = 'https://api.copy2000.online';
    _content = null;
    _requests = new Map();

    // API headers are local to this novel source, without comic tokens or settings.
    apiHeaders() {
        return {'User-Agent': 'COPY/3.0.6', source: 'copyApp', platform: '3',
            version: '3.0.6', Referer: 'com.copymanga.app-3.0.6', Accept: 'application/json', webp: '1'};
    }

    path(id) {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('无效小说 ID');
        return '/api/v3/book/' + encodeURIComponent(id);
    }

    // Treat API error codes like HTTP errors so the client can pause on access limits.
    async api(path, query = {}) {
        const params = Object.assign({platform: 3}, query);
        const url = this.base + path + '?' + Object.entries(params)
            .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
        const response = await Network.fetchBytes('GET', url, this.apiHeaders(), null);
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：拷贝小说请求失败');
        const data = JSON.parse(Convert.decodeUtf8(response.body));
        if (data.code !== 200) throw new Error('HTTP ' + data.code + '：拷贝小说接口拒绝请求');
        if (!data.results || typeof data.results !== 'object') throw new Error('拷贝小说接口格式已变化');
        return data.results;
    }

    // A login/VIP flag alone does not mean locked; obey the explicit access flag.
    accessible(result) {
        if (result.is_lock === true) throw new Error('HTTP 403：该卷或小说需要登录或访问权限');
    }

    book(value) {
        this.path(value.path_word);
        if (typeof value.name !== 'string' || !value.name.trim()) throw new Error('小说缺少标题');
        return {id: value.path_word, title: value.name.trim(),
            author: (value.author || []).map(a => a.name || '').filter(Boolean).join(' / '),
            cover: value.cover || '', description: value.brief || '',
            status: value.status && typeof value.status === 'object' ? value.status.display || '' :
                value.status === 1 ? '已完结' : value.status === 0 ? '连载中' : '',
            updated: value.datetime_updated || '', url: this.base + this.path(value.path_word)};
    }

    // Bind offsets to their query so an old search/category cannot supply a new page.
    async books(path, query, cursor) {
        const scope = JSON.stringify([path, query]);
        let offset = 0;
        if (cursor != null) {
            const page = JSON.parse(cursor);
            if (page.scope !== scope || !Number.isSafeInteger(page.offset) || page.offset < 1) {
                throw new Error('无效小说列表续页');
            }
            offset = page.offset;
        }
        const result = await this.api(path, Object.assign({}, query, {limit: 18, offset}));
        if (!Array.isArray(result.list) || !Number.isSafeInteger(result.total) || result.total < 0 ||
            result.offset !== offset || !Number.isSafeInteger(result.limit) || result.limit < 1 ||
            result.list.length > result.limit) throw new Error('小说列表分页格式已变化');
        const next = offset + result.list.length;
        if (!result.list.length && offset < result.total) throw new Error('小说列表未获取完整，请重试');
        return {books: result.list.map(value => this.book(value)),
            nextCursor: next < result.total ? JSON.stringify({scope, offset: next}) : null};
    }

    async search(keyword, cursor) {
        const q = keyword.trim();
        if (!q) throw new Error('请输入搜索关键词');
        return this.books('/api/v3/search/books', {q, q_type: ''}, cursor);
    }

    async loadNovelInfo(id) {
        const result = await this.api(this.path(id));
        this.accessible(result);
        if (!result.book || result.book.path_word !== id) throw new Error('小说详情身份不匹配');
        return this.book(result.book);
    }

    // Each volume has a stable upstream ID. Catalog loading never fetches its TXT.
    async loadCatalog(id, cursor) {
        if (cursor != null) throw new Error('拷贝卷目录不支持续页');
        const result = await this.api(this.path(id) + '/volumes');
        if (!Array.isArray(result.list) || !result.list.length || result.total !== result.list.length) {
            throw new Error('卷目录未获取完整，请重试');
        }
        const seen = new Set();
        const chapters = result.list.map(volume => {
            const cid = String(volume.id);
            if (!/^[0-9]{1,20}$/.test(cid) || seen.has(cid) ||
                typeof volume.name !== 'string' || !volume.name.trim()) throw new Error('卷目录格式已变化');
            seen.add(cid);
            return {id: cid, title: volume.name.trim(),
                url: this.base + this.path(id) + '/volume/' + cid};
        });
        return {chapters, complete: true, nextCursor: null};
    }

    // Accept exact public resource addresses; do not guess filenames or weaken TLS.
    resource(url) {
        if (typeof url !== 'string' || !/^https?:\/\/[^\s/@?#]+(?::\d+)?(?:[/?#]|$)/i.test(url)) {
            throw new Error('正文或插图地址无效');
        }
        return url;
    }

    hash(bytes) {
        return Array.from(new Uint8Array(Convert.sha256(bytes)))
            .map(value => value.toString(16).padStart(2, '0')).join('');
    }

    // Preserve original line indices and encoding, including empty lines and a BOM.
    async text(volume) {
        const response = await Network.fetchBytes('GET', this.resource(volume.txt_addr),
            {Accept: '*/*'}, null);
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：卷正文获取失败');
        if (!response.body || response.body.byteLength > 4 * 1024 * 1024) throw new Error('卷正文过大，暂不支持读取');
        const encoding = String(volume.txt_encoding || '').trim().toLowerCase().replace(/[-_]/g, '');
        let value;
        if (encoding === 'utf8') value = Convert.decodeUtf8(response.body);
        else if (['gbk', 'gb2312', 'cp936'].includes(encoding)) value = Convert.decodeGbk(response.body);
        else throw new Error('不支持的卷正文编码：' + encoding);
        if (value.charCodeAt(0) === 0xfeff) value = value.substring(1);
        if (/^\s*<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(value)) throw new Error('卷正文返回了错误网页');
        const lines = value.split(/\r\n|\n|\r/);
        if (lines.length > 50000) throw new Error('卷正文行数过多，暂不支持读取');
        return {lines, revision: this.hash(response.body)};
    }

    // Only one parsed volume is cached; concurrent reads of that volume share work.
    async volume(id, cid) {
        this.path(id);
        if (!/^[0-9]{1,20}$/.test(cid)) throw new Error('无效卷 ID');
        const key = id + ':' + cid;
        if (this._content && this._content.key === key && Date.now() < this._content.expires) return this._content;
        if (this._requests.has(key)) return this._requests.get(key);
        if (this._requests.size >= 2) throw new Error('小说请求繁忙，请稍后重试');
        const pending = this.parseVolume(id, cid).then(content => {
            this._content = Object.assign(content, {key, expires: Date.now() + 5 * 60 * 1000});
            return this._content;
        });
        this._requests.set(key, pending);
        try { return await pending; }
        finally { this._requests.delete(key); }
    }

    // Emit native paragraphs/images in source order; missing ranges retain usable blocks.
    async parseVolume(id, cid) {
        const result = await this.api(this.path(id) + '/volume/' + cid);
        this.accessible(result);
        const volume = result.volume;
        if (!volume || String(volume.id) !== cid || volume.book_path_word !== id ||
            !result.book || result.book.path_word !== id) throw new Error('卷正文身份不匹配');
        if (!Array.isArray(volume.contents) || !volume.contents.length || volume.contents.length > 2000) {
            throw new Error('该卷尚未提供有效正文目录');
        }
        const hasText = volume.contents.some(entry => entry.content_type === 1);
        const text = hasText ? await this.text(volume) : {lines: [], revision: ''};
        const blocks = [];
        let missing = false, readable = false;
        for (let index = 0; index < volume.contents.length; index++) {
            const entry = volume.contents[index], prefix = cid + ':' + index;
            if (entry.content_type === 2) {
                try {
                    blocks.push({id: prefix + ':image', type: 'image', url: this.resource(entry.content)});
                    readable = true;
                } catch (_) { missing = true; }
            } else if (entry.content_type === 1) {
                const start = entry.start_lines, end = entry.end_lines;
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
                    throw new Error('卷正文目录行号无效');
                }
                if (end > text.lines.length) missing = true;
                const title = typeof entry.name === 'string' ? entry.name.trim() : '';
                if (title && title !== (text.lines[start] || '').trim()) {
                    blocks.push({id: prefix + ':heading', type: 'text', text: title});
                }
                let entryReadable = false;
                for (let line = start; line < Math.min(end, text.lines.length); line++) {
                    const paragraph = text.lines[line].trim();
                    if (!paragraph) continue;
                    for (let part = 0; part < paragraph.length;) {
                        let limit = Math.min(part + 8192, paragraph.length);
                        if (limit < paragraph.length && paragraph.charCodeAt(limit - 1) >= 0xd800 &&
                            paragraph.charCodeAt(limit - 1) <= 0xdbff) limit--;
                        blocks.push({id: prefix + ':' + line + ':' + part, type: 'text', text: paragraph.substring(part, limit)});
                        part = limit;
                    }
                    entryReadable = true;
                }
                readable = readable || entryReadable;
                if (!entryReadable) missing = true;
            } else { missing = true; }
            if (blocks.length > 40000) throw new Error('卷正文段落过多，暂不支持读取');
        }
        if (!readable) throw new Error('该卷没有可读正文或插图');
        return {blocks, missing, revision: this.hash(Convert.encodeUtf8(JSON.stringify(volume.contents) + text.revision))};
    }

    // A bounded page keeps bridge transfers small without re-downloading the same TXT.
    async loadChapter(id, cid, cursor) {
        const page = cursor == null ? null : JSON.parse(cursor);
        if (page && (page.id !== id || page.cid !== cid || !Number.isSafeInteger(page.offset) || page.offset < 1)) {
            throw new Error('无效卷正文续页');
        }
        if (!page && this._content && this._content.key === id + ':' + cid && this._content.missing) {
            this._content = null;
        }
        const content = await this.volume(id, cid);
        let offset = 0;
        if (page) {
            if (page.revision !== content.revision || page.offset >= content.blocks.length) {
                throw new Error('卷正文续页已失效，请从该卷重新读取');
            }
            offset = page.offset;
        }
        const blocks = [];
        let characters = 0;
        while (offset < content.blocks.length && blocks.length < 800 && characters < 96000) {
            const block = content.blocks[offset++];
            blocks.push(block);
            characters += (block.text || block.url).length;
        }
        const nextCursor = offset < content.blocks.length ? JSON.stringify({id, cid, revision: content.revision, offset}) : null;
        return {schemaVersion: 1, blocks, nextCursor, complete: !nextCursor && !content.missing,
            hasMissingContent: content.missing, notice: content.missing ? '该卷有正文或插图地址未获取完整，可重试或结束保留' : ''};
    }

    async discover(kind, cursor) {
        const query = {ordering: kind === 'popular' ? '-popular' : kind === 'new' ? '-datetime_created' : '-datetime_updated'};
        if (kind.startsWith('category:')) query.theme = kind.substring(9);
        else if (!['popular', 'latest', 'new'].includes(kind)) throw new Error('未知小说栏目');
        return this.books('/api/v3/books', query, cursor);
    }

    async categories() {
        const result = await this.api('/api/v3/theme/book/count', {free_type: 1, limit: 500, offset: 0});
        if (!Array.isArray(result.list) || result.total !== result.list.length) throw new Error('小说分类未获取完整');
        return result.list.map(value => {
            if (typeof value.path_word !== 'string' || !value.path_word || typeof value.name !== 'string' || !value.name.trim()) {
                throw new Error('小说分类格式已变化');
            }
            return {id: value.path_word, title: value.name.trim()};
        });
    }

    imageHeaders() {
        return {Accept: 'image/*'};
    }
}
