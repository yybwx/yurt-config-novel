class Shuku52NovelSource extends NovelSource {
    name = '52书库';
    key = 'shuku52';
    version = '1.0.0';
    url = 'https://raw.githubusercontent.com/yybwx/yurt-config-novel/main/shuku52.js';
    capabilities = ['discover', 'categories'];
    base = 'https://www.52shuku.net';

    // Book IDs are the site's own catalog paths, e.g. gl/20_b/bjV7w or the legacy gl/<hash>.
    // Catalog names are lower-case only, so nav pages like /Top/GL.html are not book links.
    bookId(href) {
        const value = String(href || '').replace(/&amp;/g, '&');
        const match = value.match(/(?:https?:\/\/www\.52shuku\.net)?\/([a-z]+)\/((?:\d+_b\/)?[A-Za-z0-9]+)\.html/);
        if (!match) return '';
        if (['tuijian', 'zuozhe', 'so', 'top'].includes(match[1]) || match[2].toLowerCase() === 'index') return '';
        return match[1] + '/' + match[2];
    }

    validId(id) {
        return typeof id === 'string' &&
            /^[a-z]+\/(?:\d+_b\/)?[A-Za-z0-9]{2,64}$/.test(id) &&
            !['tuijian', 'zuozhe', 'so', 'top'].includes(id.split('/')[0]) &&
            !/\/index$/i.test(id);
    }

    bookUrl(id) { return this.base + '/' + id + '.html'; }

    pageUrl(id, page) { return this.base + '/' + id + '_' + page + '.html'; }

    // Resolve only public HTTP references; ignore javascript: and other schemes.
    absolute(value) {
        if (!value) return '';
        value = value.replace(/&amp;/g, '&');
        if (/^https?:\/\//i.test(value)) return value;
        if (value.startsWith('//')) return 'https:' + value;
        if (/^[a-z]+:/i.test(value)) return '';
        return this.base + (value.startsWith('/') ? value : '/' + value);
    }

    // The site misdecodes lower-case percent hex, so encode like a browser.
    encodeQuery(value) {
        return Array.from(new Uint8Array(Convert.encodeUtf8(value)))
            .map(b => '%' + b.toString(16).padStart(2, '0').toUpperCase()).join('');
    }

    async html(url) {
        const response = await Network.fetchBytes('GET', url,
            {Referer: this.base + '/', Accept: 'text/html', 'http_client': 'dart:io'}, null);
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：52书库请求失败 ' + url);
        const result = Convert.decodeUtf8(response.body);
        if (/Just a moment|cf-chl-|captcha-container|Attention Required/i.test(result)) {
            throw new Error('52书库需要浏览器验证');
        }
        return result;
    }

    // Titles keep the source's own naming; the leading ranking digits are site chrome.
    parseBooks(markup) {
        const doc = new HtmlDocument(markup), books = [], seen = new Set();
        try {
            for (const link of doc.querySelectorAll('a')) {
                const id = this.bookId(link.attributes.href || '');
                const title = link.text.trim().replace(/^\d+[.、]\s*/, '');
                if (!id || !title || seen.has(id)) continue;
                seen.add(id);
                books.push({id, title, url: this.bookUrl(id)});
            }
        } finally { doc.dispose(); }
        return books;
    }

    async search(keyword, cursor) {
        const q = keyword.trim();
        if (!q) throw new Error('请输入搜索关键词');
        let page = 1;
        if (cursor != null) {
            const state = JSON.parse(cursor);
            if (state.q !== q || !Number.isSafeInteger(state.p) || state.p < 1) throw new Error('无效搜索续页');
            page = state.p;
        }
        const markup = await this.html(this.base + '/so/search.php?q=' + this.encodeQuery(q) +
            '&m=no&f=_all&syn=no&p=' + page);
        const next = new RegExp('(?:href|value)=["\'][^"\']*search\\.php[^"\']*&(?:amp;)?p=' +
            (page + 1) + '(?:[&"\'])').test(markup);
        return {books: this.parseBooks(markup),
            nextCursor: next ? JSON.stringify({q, p: page + 1}) : null};
    }

    async loadNovelInfo(id) {
        if (!this.validId(id)) throw new Error('无效小说 ID');
        const markup = await this.html(this.bookUrl(id));
        const doc = new HtmlDocument(markup);
        try {
            const heading = doc.querySelector('.article-title');
            const article = doc.querySelector('article.article-content') || doc.querySelector('.article-content');
            const title = heading ? heading.text.trim() : '';
            if (!title || !article) throw new Error('小说详情结构已变化');
            const paragraphs = [];
            for (const child of article.nodes) {
                if (child.type === 'text') continue;
                const paragraph = child.toElement();
                if (!paragraph || paragraph.localName !== 'p') continue;
                const text = paragraph.text.trim();
                if (/^(所属专题|Tips)/.test(text)) break;
                if (text && text !== '小说简介：') paragraphs.push(text);
                if (paragraphs.length >= 8) break;
            }
            const stamp = doc.querySelector('time.muted');
            const parts = title.split('_');
            const author = parts.length > 1 ? parts.slice(1).join('_').replace(/【.*$/, '').trim() : '';
            return {id, title, author, description: paragraphs.join('\n'),
                status: /【[^】]*完结/.test(title) ? '已完结' : '',
                updated: stamp ? stamp.text.trim() : '', url: this.bookUrl(id)};
        } finally { doc.dispose(); }
    }

    // The site paginates a whole book into numbered pages, so the catalog offers it as one unit.
    async loadCatalog(id, cursor) {
        if (cursor != null) throw new Error('52书库目录不支持续页');
        if (!this.validId(id)) throw new Error('无效小说 ID');
        const markup = await this.html(this.bookUrl(id));
        const doc = new HtmlDocument(markup);
        let pages = 0;
        try {
            const prefix = this.base + '/' + id + '_';
            for (const link of doc.querySelectorAll('a')) {
                const value = this.absolute(link.attributes.href || '');
                if (!value.startsWith(prefix)) continue;
                const match = value.substring(prefix.length).match(/^([0-9]{1,5})\.html(?:[?#].*)?$/);
                const page = match ? Number(match[1]) : 0;
                if (page >= 2 && page > pages) pages = page;
            }
        } finally { doc.dispose(); }
        if (pages < 2) throw new Error('目录未返回可读内容');
        return {chapters: [{id: 'full', title: '全书正文（共 ' + (pages - 1) + ' 页）',
            url: this.bookUrl(id)}], complete: true, nextCursor: null};
    }

    // Follow only this book's own next-page address; other links never extend the chapter.
    async loadChapter(id, chapterId, cursor) {
        if (!this.validId(id) || chapterId !== 'full') throw new Error('无效章节地址');
        let page = 2;
        if (cursor != null) {
            page = Number(cursor);
            if (!Number.isSafeInteger(page) || page < 2 || page > 100000) throw new Error('无效正文续页');
        }
        const markup = await this.html(this.pageUrl(id, page));
        const doc = new HtmlDocument(markup);
        try {
            const article = doc.querySelector('article.article-content') || doc.querySelector('.article-content');
            if (!article) throw new Error('章节正文结构已变化');
            const blocks = [];
            let paragraph = '', stopped = false;
            const blockId = () => 'p' + page + ':' + blocks.length;
            const flush = () => {
                const text = paragraph.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
                paragraph = '';
                if (text) blocks.push({id: blockId(), type: 'text', text});
            };
            const walk = element => {
                for (const node of element.nodes) {
                    if (stopped) return;
                    if (node.type === 'text') { paragraph += node.text; continue; }
                    const child = node.toElement();
                    if (!child) continue;
                    if (/pagination2/.test(child.attributes.class || '')) { stopped = true; return; }
                    if (/^(script|style|iframe|noscript|ins)$/.test(child.localName)) continue;
                    if (child.localName === 'br') { flush(); continue; }
                    if (child.localName === 'img') {
                        flush();
                        const image = this.absolute(child.attributes['data-original'] ||
                            child.attributes['data-src'] || child.attributes.src);
                        if (image) blocks.push({id: blockId(), type: 'image', url: image});
                        continue;
                    }
                    walk(child);
                    if (/^(p|div|ul|ol|li|h[1-6])$/.test(child.localName)) flush();
                }
            };
            walk(article);
            flush();
            if (!blocks.length) throw new Error('页面没有可读正文');
            let nextCursor = null, broken = false;
            const prefix = this.base + '/' + id + '_';
            for (const link of doc.querySelectorAll('a')) {
                if (link.text.trim() !== '下一页') continue;
                const value = this.absolute(link.attributes.href || '');
                const match = value.startsWith(prefix)
                    ? value.substring(prefix.length).match(/^([0-9]{1,5})\.html(?:[?#].*)?$/) : null;
                const next = match ? Number(match[1]) : 0;
                if (next > page && next <= 100000 && (!nextCursor || next < Number(nextCursor))) {
                    nextCursor = String(next);
                } else { broken = true; }
            }
            if (broken) throw new Error('正文翻页地址异常');
            return {schemaVersion: 1, blocks, nextCursor, complete: !nextCursor,
                hasMissingContent: false, notice: ''};
        } finally { doc.dispose(); }
    }

    async discover(kind, cursor) {
        const page = Number(cursor || '1');
        if (!Number.isInteger(page) || page < 1 || page > 5000) throw new Error('无效分页');
        let path, paginated = false;
        if (kind.startsWith('category:')) {
            const category = kind.substring(9);
            if (!/^[a-z]+$/.test(category) || ['tuijian', 'zuozhe', 'so'].includes(category)) {
                throw new Error('未知小说分类');
            }
            path = page === 1 ? '/' + category + '/' : '/' + category + '/index_' + page + '.html';
            paginated = true;
        } else if (kind === 'popular') path = '/Top/';
        else if (kind === 'latest' || kind === 'new') path = '/';
        else throw new Error('未知小说栏目');
        const markup = await this.html(this.base + path);
        const books = this.parseBooks(markup);
        const next = paginated && books.length &&
            new RegExp('(?:href|value)=["\'][^"\']*index_' + (page + 1) + '\\.html').test(markup);
        return {books, nextCursor: next ? String(page + 1) : null};
    }

    categories() {
        return [{id: 'gl', title: 'GL百合'}, {id: 'bl', title: '综漫同人'},
            {id: 'xiandaidushi', title: '现代耽美'}, {id: 'chongsheng', title: '穿越耽美'},
            {id: 'jiakong', title: '古架耽美'}, {id: 'yanqing', title: '言情小说'},
            {id: 'nan', title: '男频小说'}, {id: 'chuanyue', title: '穿越重生'},
            {id: 'wuxia', title: '武侠玄幻'}, {id: 'jiakonglishi', title: '军事历史'},
            {id: 'kongbulingyi', title: '恐怖灵异'}, {id: 'tuili', title: '推理悬疑'},
            {id: 'wenxue', title: '文学'}];
    }

    imageHeaders() {
        return {Accept: 'image/*', Referer: this.base + '/'};
    }
}
