const url = require('url');
const psl = require('psl');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const LanguageDetect = require('languagedetect');
const Wappalyzer = require('./wappalyzer');
const InvalidRedirectError = require('./errors/InvalidRedirectError');

const languageDetect = new LanguageDetect();

languageDetect.setLanguageType('iso2');

const json = JSON.parse(fs.readFileSync(path.resolve(`${__dirname}/apps.json`)));

const extensions = /(^[^.]+$|\.(asp|aspx|cgi|htm|html|jsp|php)$)/;

const errorTypes = {
  RESPONSE_NOT_OK: 'Response was not ok',
  NO_RESPONSE: 'No response from server',
  NO_HTML_DOCUMENT: 'No HTML document',
};

function getBasePath(pathname) {
  const basePathIdx = pathname.indexOf('/', 1);
  return basePathIdx === -1 ? pathname : pathname.substring(0, basePathIdx);
}

function sleep(ms) {
  return ms ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function processJs(window, patterns) {
  const js = {};

  Object.keys(patterns).forEach((appName) => {
    js[appName] = {};

    Object.keys(patterns[appName]).forEach((chain) => {
      js[appName][chain] = {};

      patterns[appName][chain].forEach((pattern, index) => {
        const properties = chain.split('.');

        let value = properties
          .reduce((parent, property) => (parent && parent[property]
            ? parent[property] : null), window);

        value = typeof value === 'string' || typeof value === 'number' ? value : !!value;

        if (value) {
          js[appName][chain][index] = value;
        }
      });
    });
  });

  return js;
}

function processHtml(html, maxCols, maxRows) {
  if (maxCols || maxRows) {
    const chunks = [];
    const rows = html.length / maxCols;

    let i;

    for (i = 0; i < rows; i += 1) {
      if (i < maxRows / 2 || i > rows - maxRows / 2) {
        chunks.push(html.slice(i * maxCols, (i + 1) * maxCols));
      }
    }

    html = chunks.join('\n');
  }

  return html;
}

class Driver {
  constructor(Browser, pageUrl, options) {
    this.options = Object.assign({}, {
      password: '',
      proxy: null,
      username: '',
      chunkSize: 5,
      debug: false,
      delay: 500,
      htmlMaxCols: 2000,
      htmlMaxRows: 3000,
      maxDepth: 3,
      maxUrls: 10,
      maxWait: 5000,
      recursive: false,
    }, options || {});

    this.options.debug = Boolean(+this.options.debug);
    this.options.recursive = Boolean(+this.options.recursive);
    this.options.delay = this.options.recursive ? parseInt(this.options.delay, 10) : 0;
    this.options.maxDepth = parseInt(this.options.maxDepth, 10);
    this.options.maxUrls = parseInt(this.options.maxUrls, 10);
    this.options.maxWait = parseInt(this.options.maxWait, 10);
    this.options.htmlMaxCols = parseInt(this.options.htmlMaxCols, 10);
    this.options.htmlMaxRows = parseInt(this.options.htmlMaxRows, 10);

    this.origPageUrl = url.parse(pageUrl);
    this.origDomain = psl.parse(this.origPageUrl.hostname);
    this.recoveredTimeoutError = false;
    this.redirectUrl = null;
    this.analyzedPageUrls = {};
    this.apps = [];
    this.basePaths = [];
    this.meta = {};
    this.listeners = {};
    this.screenshot = null;
    this.pageTexts = {};
    this.notDetectedTech = {
      scripts: new Set(),
      headers: new Set(),
      cookies: new Set(),
      metas: new Set(),
    };

    this.Browser = Browser;

    this.wappalyzer = new Wappalyzer();

    this.wappalyzer.apps = json.apps;
    this.wappalyzer.categories = json.categories;

    this.wappalyzer.parseJsPatterns();

    this.wappalyzer.driver.log = (message, source, type) => this.log(message, source, type);
    this.wappalyzer.driver
      .displayApps = (detected, meta, context) => this.displayApps(detected, meta, context);
    this.wappalyzer.driver
      .displayNotDetected = tech => this.trackNotDetectedTech(tech);
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }

    this.listeners[event].push(callback);
  }

  removeListeners() {
    Object.keys(this.listeners).forEach((key) => {
      delete this.listeners[key];
    });
  }

  emit(event, params) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(listener => listener(params));
    }
  }

  analyze() {
    this.time = {
      start: new Date().getTime(),
      last: new Date().getTime(),
    };

    return this.crawl(this.origPageUrl);
  }

  log(message, source, type) {
    if (this.options.debug) {
      // eslint-disable-next-line no-console
      console.log(`[wappalyzer ${type}]`, `[${source}]`, message);
    }

    this.emit('log', { message, source, type });
  }

  trackNotDetectedTech(technologies) {
    const {
      scripts,
      headers,
      cookies,
      metas,
    } = technologies;

    if (scripts && Array.isArray(scripts)) {
      scripts.forEach(x => this.notDetectedTech.scripts.add(x));
    }
    if (headers && Array.isArray(headers)) {
      headers.forEach(x => this.notDetectedTech.headers.add(x));
    }
    if (cookies && Array.isArray(cookies)) {
      cookies.forEach(x => this.notDetectedTech.cookies.add(x));
    }
    if (metas && Array.isArray(metas)) {
      metas.forEach(x => this.notDetectedTech.metas.add(x));
    }
  }

  displayApps(detected, meta) {
    this.meta = meta;

    Object.keys(detected).forEach((appName) => {
      const app = detected[appName];

      const categories = [];

      app.props.cats.forEach((id) => {
        const category = {};

        category[id] = json.categories[id].name;

        categories.push(category);
      });

      if (!this.apps.some(detectedApp => detectedApp.name === app.name)) {
        this.apps.push({
          name: app.name,
          confidence: app.confidenceTotal.toString(),
          version: app.version || null,
          icon: app.props.icon || 'default.svg',
          website: app.props.website,
          cpe: app.props.cpe || null,
          categories,
        });
      }
    });
  }

  async fetch(pageUrl, index, depth) {
    // Return when the URL is a duplicate or maxUrls has been reached
    if (
      this.analyzedPageUrls[pageUrl.href]
      || this.analyzedPageUrls.length >= this.options.maxUrls
    ) {
      return [];
    }

    this.analyzedPageUrls[pageUrl.href] = {
      status: 0,
    };

    const timerScope = {
      last: new Date().getTime(),
    };

    this.timer(`fetch; url: ${pageUrl.href}; depth: ${depth}; delay: ${this.options.delay * index}ms`, timerScope);

    await sleep(this.options.delay * index);

    try {
      return await this.visit(pageUrl, timerScope);
    } catch (error) {
      if (error.message === 'RESPONSE_NOT_OK_RETRY') {
        try {
          const r = await this.visit(pageUrl, timerScope, true);
          this.recoveredTimeoutError = true;
          return r;
        } catch (e) {
          this.wappalyzer.log('Retrying page failed', 'browser', 'error');
        }
      }
      throw new Error(error.message);
    }
  }

  browserFork(pageUrl, simple, screenshot, first, options) {
    return new Promise(((resolve, reject) => {
      const flags = { simple, screenshot, first };
      const pptr = fork(`${__dirname}/browsers/pptr.js`, [pageUrl.href, JSON.stringify(flags), JSON.stringify(options)]);
      const res = {};

      pptr.on('exit', (code) => {
        this.log(`child_process exited with code ${code}`, 'driver', 'info');
        if (code === 0) {
          resolve(res);
        } else if (Object.prototype.hasOwnProperty.call(res, 'error')) {
          if (res.error.type === 'redirect') {
            reject(new InvalidRedirectError(res.error.originalUrl, res.error.redirectUrl));
          } else {
            reject(new Error(res.error.message));
          }
        } else {
          reject();
        }
      });

      pptr.on('message', (message) => {
        if (message.type === 'log') {
          const { message: msg, source, type } = message.data;
          this.log(msg, source, type);
        } else if (message.type === 'ss') {
          Object.assign(res, { ss: message.data.data });
        } else if (message.type === 'data') {
          Object.assign(res, message.data);
        } else if (message.type === 'error') {
          Object.assign(res, { error: message.data });
        }
      });
    }));
  }

  async visit(pageUrl, timerScope, retry = false) {
    this.timer(`visit start; url: ${pageUrl.href}`, timerScope);

    const ss = this.screenshot === null;
    const simpleLoad = this.recoveredTimeoutError || retry;
    const first = this.origPageUrl === pageUrl;

    let browser;
    try {
      browser = await this.browserFork(pageUrl, simpleLoad, ss, first, this.options);
    } catch (error) {
      if (error instanceof InvalidRedirectError && first) {
        this.redirectUrl = error.redirectUrl;
      } else if (!retry) {
        this.log('Retrying page visit', 'browser', 'warn');
        throw new Error('RESPONSE_NOT_OK_RETRY');
      }

      this.log(error.message, 'browser', 'error');
      throw new Error('RESPONSE_NOT_OK');
    }

    this.timer(`visit end; url: ${pageUrl.href}`, timerScope);

    this.analyzedPageUrls[pageUrl.href].status = browser.statusCode;

    // Validate response
    if (!browser || !browser.statusCode) {
      throw new Error('NO_RESPONSE');
    }

    if (browser.ss && this.screenshot === null) {
      this.screenshot = Buffer.from(browser.ss);
    }
    this.copyPageTexts(browser.pageTexts);

    const { cookies, headers, scripts } = browser;

    const html = processHtml(browser.html, this.options.htmlMaxCols, this.options.htmlMaxRows);
    const js = processJs(browser.js, this.wappalyzer.jsPatterns);

    let language = null;

    try {
      [[language]] = languageDetect.detect(html.replace(/<\/?[^>]+(>|$)/g, ' '), 1);
    } catch (error) {
      this.wappalyzer.log(`${error.message || error}; url: ${pageUrl.href}`, 'driver', 'error');
    }

    await this.wappalyzer.analyze(pageUrl, {
      cookies,
      headers,
      html,
      js,
      scripts,
      language,
    });

    const previousUrls = Object.keys(this.analyzedPageUrls);
    const reducedLinks = Array.prototype.reduce.call(
      browser.links, (results, link) => {
        if (
          results
          && Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(results), 'push')
          && link.protocol
          && link.protocol.match(/https?:/)
          && link.rel !== 'nofollow'
          && psl.parse(link.hostname).domain === this.origDomain.domain
          && extensions.test(link.pathname)
        ) {
          const href = `${link.protocol}//${link.hostname}${link.pathname}${link.search}`;
          // const bp = getBasePath(link.pathname);

          // if (!results.some(x => x.href === href) && !this.basePaths.some(x => x === bp)) {
          if (!results.some(x => x.href === href) && !previousUrls.includes(href)) {
            const parsedLink = url.parse(href);
            parsedLink.slashesCount = (parsedLink.pathname.match(/\//g) || []).length;
            results.push(parsedLink);
            // this.basePaths.push(bp);
          }
        }
        return results;
      }, [],
    );
    reducedLinks.sort((lhs, rhs) => lhs.slashesCount - rhs.slashesCount);

    // this.emit('visit', { browser, pageUrl });

    return reducedLinks;
  }

  copyPageTexts(pageTexts) {
    ['title', 'site_name', 'description', 'secondary_title', 'page_text', 'jsonld'].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(this.pageTexts, key)
        && Object.prototype.hasOwnProperty.call(pageTexts, key)) {
        Object.assign(this.pageTexts, { [key]: pageTexts[key] });
      }
    });
  }

  async crawl(pageUrl, index = 1, depth = 1) {
    pageUrl.canonical = `${pageUrl.protocol}//${pageUrl.host}${pageUrl.pathname}`;

    let links;

    try {
      links = await this.fetch(pageUrl, index, depth);
    } catch (error) {
      const type = error.message && errorTypes[error.message] ? error.message : 'UNKNOWN_ERROR';
      const message = error.message && errorTypes[error.message] ? errorTypes[error.message] : 'Unknown error';

      this.analyzedPageUrls[pageUrl.href].error = {
        type,
        message,
      };

      this.wappalyzer.log(`${message}; url: ${pageUrl.href}`, 'driver', 'error');
    }

    if (links && this.options.recursive && depth < this.options.maxDepth) {
      await this.chunk(links.slice(0, this.options.maxUrls), depth + 1);
    }

    return {
      urls: this.analyzedPageUrls,
      applications: this.apps,
      meta: this.meta,
      redirect: this.getRedirectInfo(),
      otherTechnologies: this.notDetectedTech,
      screenshot: this.screenshot,
      pageTexts: this.pageTexts,
    };
  }

  getRedirectInfo() {
    if (this.redirectUrl === null) {
      return {
        detected: false,
      };
    }
    const u = url.parse(this.redirectUrl).hostname;
    const d = psl.parse(u).domain;
    return {
      detected: (this.redirectUrl !== null),
      url: this.redirectUrl,
      domain: d,
    };
  }

  async chunk(links, depth, chunk = 0) {
    if (links.length === 0) {
      return;
    }

    const chunked = links.splice(0, this.options.chunkSize);

    await Promise.all(chunked.map((link, index) => this.crawl(link, index, depth)));

    await this.chunk(links, depth, chunk + 1);
  }

  timer(message, scope) {
    const time = new Date().getTime();
    const sinceStart = `${Math.round((time - this.time.start) / 10) / 100}s`;
    const sinceLast = `${Math.round((time - scope.last) / 10) / 100}s`;

    this.wappalyzer.log(`[timer] ${message}; lapsed: ${sinceLast} / ${sinceStart}`, 'driver');

    scope.last = time;
  }

  getScreenshotBuffer() {
    return this.screenshot;
  }

  getPageTexts() {
    return this.pageTexts;
  }
}

module.exports = Driver;

module.exports.processJs = processJs;
module.exports.processHtml = processHtml;
