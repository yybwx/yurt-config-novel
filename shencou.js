class ShencouNovelSource extends NovelSource {
    name = '神凑轻小说';
    key = 'shencou';
    version = '1.0.0';
    url = 'https://raw.githubusercontent.com/yybwx/yurt-config-novel/main/shencou.js';
    capabilities = ['discover', 'categories'];
    base = 'https://m.shencou.com';

    // Resolve only public HTTP references; never execute the website's scripts.
    absolute(value) {
        if (!value) return '';
        value = value.replace(/&amp;/g, '&');
        if (/^https?:\/\//i.test(value)) return value;
        if (value.startsWith('//')) return 'https:' + value;
        if (/^[a-z]+:/i.test(value)) return '';
        return this.base + '/' + value.replace(/^\//, '');
    }

    // Chinese searches use GBK percent encoding, not the browser's UTF-8 helper.
    encodeQuery(value) {
        return Array.from(new Uint8Array(Convert.encodeGbk(value)))
            .map(b => '%' + b.toString(16).padStart(2, '0')).join('');
    }

    async html(url, data) {
        const response = await Network.fetchBytes(data ? 'POST' : 'GET', url,
            {'Referer': this.base + '/', 'Content-Type': 'application/x-www-form-urlencoded', 'http_client': 'dart:io'},
            data ? Convert.encodeUtf8(data) : null);
        if (response.status !== 200) throw new Error('HTTP ' + response.status + '：小说源请求失败');
        const result = Convert.decodeGbk(response.body);
        if (/Just a moment|cf-chl-|captcha-container/i.test(result)) {
            throw new Error('小说源需要浏览器验证');
        }
        return result;
    }

    bookId(url) { return (url.match(/info\.php\?[^#]*?aid=(\d+)/) || [])[1]; }

    // Results retain source identities; the site caps searches at twenty books.
    parseBooks(html) {
        const doc = new HtmlDocument(html), books = [], seen = new Set();
        try {
            for (const link of doc.querySelectorAll('a[href*="info.php"]')) {
                const id = this.bookId(link.attributes.href || '');
                const title = link.text.trim().replace(/^《|》$/g, '');
                if (!id || !title || seen.has(id)) continue;
                seen.add(id);
                const parent = link.parent;
                const author = parent && parent.querySelector('a[href*="author.php"]');
                const image = link.querySelector('img');
                books.push({id, title, author: author ? author.text.trim() : '',
                    cover: this.absolute(image && image.attributes.src) ||
                        'https://www.wowenku.com/files/article/image/' + Math.floor(Number(id) / 1000) + '/' + id + '/' + id + 's.jpg',
                    url: this.base + '/info.php?aid=' + id});
            }
        } finally { doc.dispose(); }
        return books;
    }

    async search(keyword, cursor) {
        if (cursor) return {books: [], nextCursor: null};
        const html = await this.html(this.base + '/pserchs.php',
            's=' + this.encodeQuery(keyword) + '&q=0&type=articlename');
        return {books: this.parseBooks(html), nextCursor: null,
            notice: '该源搜索最多显示 20 条结果，可使用更精确的关键词。'};
    }

    async loadNovelInfo(id) {
        if (!/^\d+$/.test(id)) throw new Error('无效小说 ID');
        const html = await this.html(this.base + '/info.php?aid=' + id);
        const doc = new HtmlDocument(html);
        try {
            const text = selector => { const e = doc.querySelector(selector); return e ? e.text.trim() : ''; };
            const title = text('.catalog1 h1');
            if (!title) throw new Error('小说详情结构已变化');
            const image = doc.querySelector('.catalog1 .tu img');
            const summary = doc.querySelector('.jj > p');
            const summaryDoc = new HtmlDocument(summary ? summary.innerHTML.split(/<a\s+name=["']txt["']/i)[0] : '');
            let description;
            try { description = summaryDoc.querySelector('body').text.trim(); }
            finally { summaryDoc.dispose(); }
            return {id, title, author: text('.catalog1 .tab .p1').replace(/^作者[:：]\s*/, ''),
                cover: this.absolute(image && image.attributes.src), description,
                status: text('.catalog1 .p5'), updated: text('.catalog1 .tab .p2:nth-child(3)').replace(/^更新[:：]\s*/, ''),
                url: this.base + '/info.php?aid=' + id};
        } finally { doc.dispose(); }
    }

    // Only follow pagination URLs supplied by this book's current public page.
    async loadCatalog(id, cursor) {
        const url = cursor || this.base + '/info.php?aid=' + id;
        if (!url.startsWith(this.base + '/info.php?') || this.bookId(url) !== id) {
            throw new Error('无效目录续页');
        }
        const html = await this.html(url), doc = new HtmlDocument(html);
        try {
            const heading = doc.querySelectorAll('.info_chapters .p1')
                .find(e => e.text.includes('全部章节'));
            const section = heading && heading.nextElementSibling;
            if (!section || section.localName !== 'ul') throw new Error('小说目录结构已变化');
            const chapters = [], seen = new Set();
            let volume = '';
            for (const item of section.querySelectorAll('li')) {
                const heading = item.text.match(/[〖【](.+?)[〗】]/);
                if (heading) volume = heading[1];
                const link = item.querySelector('a[href*="chapter.php"]');
                if (!link) continue;
                const match = (link.attributes.href || '').match(/aid=(\d+)&(?:amp;)?cid=(\d+)/);
                const raw = link.text.trim();
                if (!match || match[1] !== id || /章节功能被拦截|章节不完整/.test(raw) || seen.has(match[2])) continue;
                const name = raw.replace(/^\d+\./, '');
                const prefix = name.match(/^(.+?)>/);
                if (prefix) volume = prefix[1];
                seen.add(match[2]);
                chapters.push({id: match[2], title: name.replace(/^.+?>/, ''), volume,
                    url: this.base + '/chapter.php?aid=' + id + '&cid=' + match[2]});
            }
            if (!chapters.length) throw new Error('目录未返回章节，不能标为完整');
            const current = Number((url.match(/[?&]page=(\d+)/) || [0, 1])[1]);
            // The template is parsed as inert HTML rather than evaluated JavaScript.
            const template = (html.match(/<select\s+name=["']pageselect["'][\s\S]*?<\/select>/i) || [''])[0];
            const pagination = new HtmlDocument(template);
            let nextCursor = null;
            try {
                for (const option of pagination.querySelectorAll('option')) {
                    const value = this.absolute(option.attributes.value || '');
                    const page = Number((value.match(/[?&]page=(\d+)/) || [0, 0])[1]);
                    if (this.bookId(value) === id && page === current + 1) { nextCursor = value; break; }
                }
            } finally { pagination.dispose(); }
            return {chapters, nextCursor, complete: !nextCursor};
        } finally { doc.dispose(); }
    }

    // Preserve paragraph/image ordering, including chapters made entirely of illustrations.
    async loadChapter(id, chapterId, cursor) {
        const url = cursor || this.base + '/chapter.php?aid=' + id + '&cid=' + chapterId;
        if (!url.startsWith(this.base + '/chapter.php?') || !/^\d+$/.test(id) || !/^\d+$/.test(chapterId)) {
            throw new Error('无效章节地址');
        }
        const html = await this.html(url), doc = new HtmlDocument(html);
        try {
            const body = doc.getElementById('novelcontent');
            if (!body) throw new Error('章节正文结构已变化');
            const blocks = [], page = (url.match(/[?&]page=(\d+)/) || [0, '1'])[1];
            let paragraph = '', notice = '';
            const blockId = () => chapterId + ':' + page + ':' + blocks.length;
            const flush = () => {
                const text = paragraph.replace(/\r/g, '').trim(); paragraph = '';
                if (text) blocks.push({id: blockId(), type: 'text', text});
            };
            const walk = element => {
                if (/^(script|style|iframe|noscript)$/.test(element.localName) ||
                    /^(adv|box900_|check-and-display)/.test(element.id || '')) return;
                for (const node of element.nodes) {
                    if (node.type === 'text') { paragraph += node.text; continue; }
                    const child = node.toElement();
                    if (!child) continue;
                    if (child.localName === 'br') { flush(); continue; }
                    if (child.localName === 'img') {
                        flush();
                        const image = this.absolute(child.attributes['data-original'] || child.attributes['data-src'] || child.attributes.src);
                        if (!image || /\/grey\.gif/.test(image)) { notice = '插图地址未获取完整'; continue; }
                        blocks.push({id: blockId(), type: 'image', url: image}); continue;
                    }
                    if (/^(p|div)$/.test(child.localName)) flush();
                    walk(child);
                    if (/^(p|div)$/.test(child.localName)) flush();
                }
            };
            walk(body); flush();
            if (!blocks.length) throw new Error('章节没有可读正文');
            if (/內容加載失敗|内容加载失败|正文加载失败/.test(body.text)) notice = '章节正文未获取完整';
            let nextCursor = null;
            for (const link of doc.querySelectorAll('a[href*="chapter.php"]')) {
                const value = this.absolute(link.attributes.href);
                const match = value.match(/aid=(\d+)&cid=(\d+)/);
                const next = Number((value.match(/[?&]page=(\d+)/) || [0, 0])[1]);
                if (match && match[1] === id && match[2] === chapterId && next === Number(page) + 1) {
                    nextCursor = value; break;
                }
            }
            return {schemaVersion: 1, blocks, nextCursor, complete: !nextCursor && !notice, notice};
        } finally { doc.dispose(); }
    }

    imageHeaders(url) {
        const match = url.match(/aid=(\d+)&cid=(\d+)/);
        return {Referer: match ? this.base + '/chapter.php?aid=' + match[1] + '&cid=' + match[2] : this.base + '/', 'http_client': 'dart:io'};
    }

    categories() {
        return [{id: '4', title: 'MFJ 文库'}, {id: '1', title: '电击文库'},
            {id: '2', title: '富士见文库'}, {id: '3', title: '角川文库'},
            {id: '14', title: '小学馆'}];
    }

    async discover(kind, cursor) {
        const page = Number(cursor || '1');
        if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('无效分页');
        const path = /^category:\d+$/.test(kind) ? '/sort.php?sortid=' + kind.split(':')[1] + '&page=' + page :
            kind === 'latest' ? '/top.php?type=lastupdate&page=' + page :
            kind === 'new' ? '/top.php?type=postdate&page=' + page :
            '/top.php?type=allvote&page=' + page;
        const html = await this.html(this.base + path), books = this.parseBooks(html);
        const next = new RegExp('(?:href|value)=["\'][^"\']*page=' + (page + 1) + '(?:[\/&"\'])').test(html);
        return {books, nextCursor: next && books.length ? String(page + 1) : null};
    }
}
