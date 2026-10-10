class Shuku69NovelSource extends NovelSource {
    name = '69书楼';
    key = 'shuku69';
    version = '1.0.0';
    url = 'https://raw.githubusercontent.com/yybwx/yurt-config-novel/main/shuku69.js';
    capabilities = ['discover', 'categories'];
    base = 'https://www.69shuba.cc';
    categoriesById = {'1': '玄幻小说', '2': '修真小说', '3': '都市小说', '4': '历史小说',
        '5': '网游小说', '6': '科幻小说', '7': '恐怖小说', '8': '其他小说'};

    validId(id) { return typeof id === 'string' && /^[0-9]{1,9}$/.test(id); }

    bookUrl(id) { return this.base + '/book/' + id + '/'; }

    // The site's own fuzzy search lives behind the author-path address.
    searchUrl(keyword) {
        const encoded = Array.from(new Uint8Array(Convert.encodeUtf8(keyword)))
            .map(b => '%' + b.toString(16).padStart(2, '0').toUpperCase()).join('');
        return this.base + '/author/' + encoded + '.html';
    }

    async html(url) {
        const response = await Network.fetchBytes('GET', url,
            {Referer: this.base + '/', Accept: 'text/html', 'http_client': 'dart:io'}, null);
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：69书楼请求失败 ' + url);
        const result = Convert.decodeUtf8(response.body);
        if (!result || /索引文件不存在/.test(result)) throw new Error('69书楼页面不存在');
        return result;
    }

    // Collect the site's book cards from grid pages (search, category, home feeds).
    parseBooks(markup) {
        const doc = new HtmlDocument(markup), books = [], seen = new Set();
        try {
            for (const link of doc.querySelectorAll('a')) {
                const match = (link.attributes.href || '').match(/(?:https?:\/\/www\.69shuba\.cc)?\/book\/(\d{1,9})\/?$/);
                const title = link.text.trim();
                if (!match || !title || title === '...' || seen.has(match[1])) continue;
                seen.add(match[1]);
                books.push({id: match[1], title, url: this.bookUrl(match[1])});
            }
        } finally { doc.dispose(); }
        return books;
    }

    async search(keyword, cursor) {
        if (cursor != null) throw new Error('69书楼搜索结果只有一页');
        const q = keyword.trim();
        if (!q) throw new Error('请输入搜索关键词');
        const books = this.parseBooks(await this.html(this.searchUrl(q)));
        return {books, nextCursor: null,
            notice: '69书楼搜索为站内模糊匹配，结果与推荐混排，只有一页。'};
    }

    cleanDescription(text) {
        let value = text.replace(/\s+/g, ' ').trim();
        value = value.replace(/^《?[^》]{1,40}》?是由作者：.*?(免费提供|提供).{0,20}在线阅读。?\s*/, '');
        const junk = value.search(/三秒记住本站|一秒记住本站|69书楼免费提供/);
        if (junk > 0) value = value.substring(0, junk).trim();
        return value;
    }

    async loadNovelInfo(id) {
        if (!this.validId(id)) throw new Error('无效小说 ID');
        const markup = await this.html(this.bookUrl(id));
        const doc = new HtmlDocument(markup);
        try {
            // The site header ships a logo h1; the book title lives in the info block.
            const info = doc.querySelector('.info');
            const heading = info ? info.querySelector('h1') : null;
            if (!heading || !info) throw new Error('小说详情结构已变化');
            const title = heading.text.trim();
            if (!title) throw new Error('小说详情结构已变化');
            const fields = info.text.replace(/\u00a0/g, ' ');
            // A redirected error page keeps an h1 but never the book fields.
            if (!/作\s*者：/.test(fields)) throw new Error('小说详情页未返回书籍信息');
            const pick = pattern => { const m = fields.match(pattern); return m ? m[1].trim() : ''; };
            const status = (fields.match(/状\s*态：\s*(连载中|已完结|完结|全本|入库)/) || [])[1] || '';
            const desc = doc.querySelector('.desc');
            return {id, title,
                author: pick(/作\s*者：\s*([^\n]{1,40}?)(?:\s*类\s*别：|$)/),
                status,
                updated: pick(/最后更新：\s*([0-9\-: ]{8,20})/),
                cover: this.base + '/img/' + id + '.jpg',
                description: this.cleanDescription(desc ? desc.text : ''),
                url: this.bookUrl(id)};
        } finally { doc.dispose(); }
    }

    // Chapter IDs grow with reading order, so the union of the book page and its
    // mulu pages sorts into the site's own ascending order after dedupe.
    parseChapters(markup, id) {
        const doc = new HtmlDocument(markup), chapters = new Map();
        try {
            for (const link of doc.querySelectorAll('a')) {
                const match = (link.attributes.href || '').match(
                    new RegExp('(?:https?://www\\.69shuba\\.cc)?/book/' + id + '/([0-9]{1,12})\\.html'));
                const title = link.text.trim();
                if (!match || !title || title === '开始阅读' || title === '...') continue;
                if (!chapters.has(match[1])) chapters.set(match[1], title);
            }
        } finally { doc.dispose(); }
        return [...chapters.entries()]
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([cid, title]) => ({id: cid, title,
                url: this.base + '/book/' + id + '/' + cid + '.html'}));
    }

    // Continue only into higher-numbered mulu pages of this book; stale buttons
    // and cyclic recommend links never extend the catalog.
    nextCatalogUrl(markup, id, current) {
        const doc = new HtmlDocument(markup);
        let next = null;
        try {
            for (const link of doc.querySelectorAll('a')) {
                const match = (link.attributes.href || '').match(
                    new RegExp('(?:https?://www\\.69shuba\\.cc)?/book/' + id + '/mulu([0-9]{1,4})\\.html'));
                if (match && Number(match[1]) > current && (!next || Number(match[1]) < Number(next[1]))) {
                    next = match;
                }
            }
        } finally { doc.dispose(); }
        return next ? this.base + '/book/' + id + '/mulu' + next[1] + '.html' : null;
    }

    async loadCatalog(id, cursor) {
        if (!this.validId(id)) throw new Error('无效小说 ID');
        let url = this.bookUrl(id), current = 0;
        if (cursor != null) {
            const match = cursor.match(/^(https?:\/\/www\.69shuba\.cc)?\/book\/(\d{1,9})\/mulu([0-9]{1,4})\.html$/);
            if (!match || match[2] !== id) throw new Error('无效目录续页');
            url = cursor.startsWith('http') ? cursor : this.base + cursor;
            current = Number(match[3]);
        }
        const markup = await this.html(url);
        const chapters = this.parseChapters(markup, id);
        if (!chapters.length) throw new Error('目录未返回章节，不能标为完整');
        const nextCursor = this.nextCatalogUrl(markup, id, current);
        return {chapters, nextCursor, complete: !nextCursor};
    }

    // The body ships as base64 paragraphs behind document.writeln; decode them
    // as inert text instead of executing the page's scripts.
    decodeParagraphs(markup) {
        const blocks = [];
        const pattern = /qsbs\.bb\('([A-Za-z0-9+/=]+)'\)/g;
        let match;
        while ((match = pattern.exec(markup)) !== null) {
            const fragment = Convert.decodeUtf8(Convert.decodeBase64(match[1]));
            for (const part of fragment.split(/<\/?p>/i)) {
                const text = part.replace(/<[^>]*>/g, '').replace(/\u00a0/g, ' ')
                    .replace(/\s+/g, ' ').trim();
                if (text) blocks.push(text);
            }
        }
        return blocks;
    }

    async loadChapter(id, cid, cursor) {
        if (!this.validId(id) || !/^[0-9]{1,12}$/.test(cid)) throw new Error('无效章节地址');
        let page = 0;
        if (cursor != null) {
            page = Number(cursor);
            if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('无效正文续页');
        }
        const url = this.base + '/book/' + id + '/' + cid + (page ? '_' + page : '') + '.html';
        const markup = await this.html(url);
        const paragraphs = this.decodeParagraphs(markup);
        if (!paragraphs.length) throw new Error('章节没有可读正文');
        const blocks = paragraphs.map((text, index) => ({
            id: cid + ':' + page + ':' + index, type: 'text', text}));
        const doc = new HtmlDocument(markup);
        let nextCursor = null;
        try {
            for (const link of doc.querySelectorAll('a')) {
                if (link.text.trim() !== '下一章') continue;
                const match = (link.attributes.href || '').match(
                    new RegExp('(?:https?://www\\.69shuba\\.cc)?/book/' + id + '/' + cid + '_([0-9]{1,4})\\.html'));
                if (match && Number(match[1]) > page && (!nextCursor || Number(match[1]) < Number(nextCursor))) {
                    nextCursor = match[1];
                }
            }
        } finally { doc.dispose(); }
        return {schemaVersion: 1, blocks, nextCursor, complete: !nextCursor,
            hasMissingContent: false, notice: ''};
    }

    // Home feeds are separated by their own section headings.
    homeSection(markup, heading) {
        const start = markup.search(new RegExp('<h[1-4][^>]*>\\s*' + heading + '\\s*</h[1-4]>'));
        if (start < 0) return '';
        const rest = markup.substring(start);
        const end = rest.substring(heading.length + 10).search(/<h[1-4][^>]*>|<footer/i);
        return end < 0 ? rest : rest.substring(0, end + heading.length + 10);
    }

    async discover(kind, cursor) {
        const feeds = {popular: '经典推荐', new: '最新入库小说', latest: '最近更新小说列表'};
        if (kind in feeds) {
            if (cursor != null) throw new Error('该栏目只有一页');
            const markup = await this.html(this.base + '/');
            const books = this.parseBooks(this.homeSection(markup, feeds[kind]));
            if (!books.length) throw new Error('首页栏目结构已变化');
            return {books, nextCursor: null};
        }
        if (!kind.startsWith('category:')) throw new Error('未知小说栏目');
        const category = kind.substring(9);
        const title = this.categoriesById[category];
        if (!title) throw new Error('未知小说分类');
        const page = Number(cursor || '1');
        if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('无效分页');
        const url = this.base + '/fenlei/' + category + '/' + page + '.html';
        const response = await Network.fetchBytes('GET', url,
            {Referer: this.base + '/', Accept: 'text/html', 'http_client': 'dart:io'}, null);
        // Out-of-range pages redirect to the home page; that ends the list.
        if (response.status === 301 || response.status === 302) return {books: [], nextCursor: null};
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：69书楼分类请求失败');
        const markup = Convert.decodeUtf8(response.body);
        const doc = new HtmlDocument(markup);
        let pageTitle = '';
        try { pageTitle = (doc.querySelector('title') || {text: ''}).text.trim(); }
        finally { doc.dispose(); }
        if (!pageTitle.startsWith(title + '_')) return {books: [], nextCursor: null};
        const books = this.parseBooks(markup);
        if (!books.length) return {books: [], nextCursor: null};
        return {books, nextCursor: String(page + 1)};
    }

    categories() {
        return Object.entries(this.categoriesById).map(([id, title]) => ({id, title}));
    }

    imageHeaders() {
        return {Accept: 'image/*', Referer: this.base + '/'};
    }
}
