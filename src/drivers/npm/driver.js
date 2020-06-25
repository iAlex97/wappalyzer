const url = require('url');
const psl = require('psl');
const fs = require('fs');
const path = require('path');
const LanguageDetect = require('languagedetect');
const Wappalyzer = require('./wappalyzer');

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
    // eslint-disable-next-line no-unused-vars
    this.pageHook = async (page, type) => { };
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
    this.analyzedPageUrls = {};
    this.apps = [];
    this.basePaths = [];
    this.meta = {};
    this.listeners = {};
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
    // in the highly unlikely case that each page is retried again
    process.setMaxListeners(2 * this.options.maxUrls + 1);
    process.on('unhandledRejection', (error) => {
      if (error.message && error.message.includes('Page crashed!')) {
        return;
      }
      this.log(`Top level unhandledRejection: ${error.message}`, 'driver', 'error');
      // throw error;
    });

    this.time = {
      start: new Date().getTime(),
      last: new Date().getTime(),
    };

    return this.crawl(this.origPageUrl)
      .finally(() => {
        process.removeAllListeners('unhandledRejection');
      });
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

  async visit(pageUrl, timerScope, retry = false) {
    const browser = new this.Browser(this.options);

    browser.log = (message, type) => this.wappalyzer.log(message, 'browser', type);

    this.timer(`visit start; url: ${pageUrl.href}`, timerScope);

    try {
      await browser.visit(pageUrl.href, this.pageHook, this.recoveredTimeoutError || retry);
    } catch (error) {
      if (!retry) {
        this.wappalyzer.log('Retrying page visit', 'browser', 'warn');
        throw new Error('RESPONSE_NOT_OK_RETRY');
      }
      this.wappalyzer.log(error.message, 'browser', 'error');
      throw new Error('RESPONSE_NOT_OK');
    }

    this.timer(`visit end; url: ${pageUrl.href}`, timerScope);

    this.analyzedPageUrls[pageUrl.href].status = browser.statusCode;

    // Validate response
    if (!browser.statusCode) {
      throw new Error('NO_RESPONSE');
    }

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
          const href = link.href.replace(link.hash, '');
          const bp = getBasePath(link.pathname);

          if (!results.some(x => x.href === href) && !this.basePaths.some(x => x === bp)) {
            const parsedLink = url.parse(href);
            parsedLink.slashesCount = (parsedLink.pathname.match(/\//g) || []).length;
            results.push(parsedLink);
            this.basePaths.push(bp);
          }
        }
        return results;
      }, [],
    );
    reducedLinks.sort((lhs, rhs) => lhs.slashesCount - rhs.slashesCount);

    this.emit('visit', { browser, pageUrl });

    return reducedLinks;
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
      otherTechnologies: this.notDetectedTech,
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
}

module.exports = Driver;

module.exports.processJs = processJs;
module.exports.processHtml = processHtml;
