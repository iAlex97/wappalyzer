const {
  AWS_LAMBDA_FUNCTION_NAME,
  CHROME_BIN,
} = process.env;

let chromium;
let puppeteer;

if (AWS_LAMBDA_FUNCTION_NAME) {
  // eslint-disable-next-line global-require, import/no-unresolved
  chromium = require('chrome-aws-lambda');

  ({ puppeteer } = chromium);
} else {
  // eslint-disable-next-line global-require
  puppeteer = require('src/browsers/puppeteer');
}
const { TimeoutError } = puppeteer.errors;
const { PuppeteerBlocker } = require('@cliqz/adblocker-puppeteer');
const fetch = require('cross-fetch');
const fs = require('fs').promises;
const psl = require('psl');
const urll = require('url');

const {
  RejectAfter, ResolveAfter, extractPageText, extractMetadata, extractSecondaryTitle,
} = require('../utils');
const InvalidRedirectError = require('../errors/InvalidRedirectError');
const { PageTextHelper, getLinksFromForms } = require('../extras/page_text_helper');
const Browser = require('../browser');

function getJsRecursive() {
  const dereference = (obj, level = 0, ts = -1) => {
    if (ts < 0) {
      ts = new Date().getTime();
    }
    if (new Date().getTime() - ts >= 2000) {
      return '[Removed]';
    }
    try {
      // eslint-disable-next-line no-undef
      if (level > 5 || (level && obj === window)) {
        return '[Removed]';
      }

      if (Array.isArray(obj)) {
        obj = obj.map(item => dereference(item, level + 1, ts));
      }

      if (obj === null) {
        return null;
      }

      if (typeof obj === 'object') {
        const newObj = {};

        Object.keys(obj).forEach((key) => {
          newObj[key] = dereference(obj[key], level + 1, ts);
        });

        return newObj;
      }

      if (typeof obj === 'function' && obj.name) {
        return { [obj.name]: '' };
      }

      return obj;
    } catch (error) {
      return undefined;
    }
  };

  // eslint-disable-next-line no-undef
  return dereference(window);
}

function getJs() {
  const customStringify = (v) => {
    const cache = new Set();
    return JSON.stringify(v, (key, value) => {
      if (value === null) {
        return null;
      }
      if (typeof value === 'object') {
        if (cache.has(value)) {
          // Circular reference found
          try {
            // If this value does not reference a parent it can be deduped
            return JSON.parse(JSON.stringify(value));
          } catch (err) {
            // discard key if value cannot be deduped
            return '[Removed]';
          }
        }
        // Store value in our set
        cache.add(value);
      }
      if (typeof value === 'function' && value.name) {
        return { [value.name]: '' };
      }
      return value;
    });
  };

  // eslint-disable-next-line no-undef
  return JSON.parse(customStringify(window));
}

function checkSameDomain(lhs, rhs) {
  return psl.parse(urll.parse(lhs).hostname).domain === psl.parse(urll.parse(rhs).hostname).domain;
}

class Puppeteer extends Browser {
  constructor(options) {
    options.maxWait = options.maxWait || 60;

    super(options);
    this.pageTexts = {};
    this.screenshot = null;
    this.requestUrls = new Set();
  }

  async visit(url, screenshot, simple, first) {
    let done = false;
    let browser;

    try {
      await new Promise(async (resolve, reject) => {
        try {
          const extraArgs = this.options.chromiumArgs || [];
          browser = await puppeteer.launch(chromium ? {
            args: [...chromium.args, '--ignore-certificate-errors'],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
          } : {
            args: ['--no-sandbox', '--headless', '--disable-gpu', '--ignore-certificate-errors', ...extraArgs],
            executablePath: CHROME_BIN,
            ignoreHTTPSErrors: true,
            handleSIGTERM: false,
          });

          browser.on('disconnected', () => {
            if (!done) {
              reject(new Error('browser: disconnected'));
            }
          });

          const page = await browser.newPage();

          let responseReceived = false;
          let responseRedirected = false;

          if (screenshot) {
            await page.setViewport({ width: 1920, height: 1080 });

            const blocker = await PuppeteerBlocker.fromLists(fetch, [
              'https://raw.githubusercontent.com/iAlex97/block-the-eu-cookie-shit-list/development/filterlist_v2.txt',
            ], {}, {
              path: 'blocker_engine.bin',
              read: fs.readFile,
              write: fs.writeFile,
            });
            await blocker.enableBlockingInPage(page);
          } else {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
              try {
                this.requestUrls.add(request.url());
                if (
                  responseReceived
                  && request.isNavigationRequest()
                  && request.frame() === page.mainFrame()
                  && request.url() !== url
                ) {
                  this.log(`abort navigation to ${request.url()}`);

                  request.abort('aborted');
                } else if (!done) {
                  if (!['document', 'script'].includes(request.resourceType())) {
                    request.abort();
                  } else {
                    request.continue();
                  }
                } else {
                  request.abort();
                }
              } catch (error) {
                reject(new Error(`page error: ${error.message || error}`));
              }
            });
          }

          page.setDefaultTimeout(this.options.maxWait * 1.1);

          page.on('error', error => reject(new Error(`page error: ${error.message || error}`)));

          page.on('response', (response) => {
            try {
              if (!this.statusCode) {
                this.statusCode = response.status();

                this.headers = {};

                const headers = response.headers();

                Object.keys(headers).forEach((key) => {
                  this.headers[key] = Array.isArray(headers[key]) ? headers[key] : [headers[key]];
                });

                this.contentType = headers['content-type'] || null;
              }

              if (response.status() < 300 || response.status() > 399) {
                responseReceived = true;
              } else {
                responseRedirected = true;
              }
            } catch (error) {
              reject(new Error(`page error: ${error.message || error}`));
            }
          });

          page.on('dialog', async (dialog) => {
            this.log('Dismissing dialog', 'info');
            if (dialog.type() === 'prompt') {
              await dialog.accept('');
            } else {
              await dialog.dismiss();
            }
          });

          // page.on('console', ({ _type, _text, _location }) => {
          //   if (!/Failed to load resource: net::ERR_FAILED|Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector|JSHandle@error/.test(_text)) {
          //     this.log(`${_text} (${_location.url}: ${_location.lineNumber})`, _type);
          //   }
          // });

          if (this.options.userAgent) {
            await page.setUserAgent(this.options.userAgent);
          }

          try {
            const pageEvents = simple ? ['domcontentloaded'] : ['domcontentloaded', 'networkidle0'];
            await Promise.race([
              page.goto(url, { waitUntil: pageEvents, timeout: this.options.maxWait - 100 }),
              RejectAfter(this.options.maxWait, 'timeout'),
            ]);
            if (responseRedirected) {
              // if page redirected and url didn't change it means
              // we need to wait for navigation to end
              if (page.url() === url) {
                await Promise.race([
                  page.waitForNavigation({
                    waitUntil: pageEvents,
                    timeout: this.options.maxWait - 100,
                  }),
                  RejectAfter(this.options.maxWait, 'timeout'),
                ]);
              }

              if (checkSameDomain(url, page.url())) {
                this.log(`Redirected from ${url} to ${page.url()}`, 'info');
              } else {
                throw new InvalidRedirectError(url, page.url());
              }
            }
          } catch (error) {
            if (error instanceof TimeoutError) {
              this.log('Attempt to ignore timeout error');
            } else if (error instanceof InvalidRedirectError) {
              throw error;
            } else {
              throw new Error(error.message || error.toString());
            }
          } finally {
            page.removeAllListeners('dialog');
            page.removeAllListeners('error');
            page.removeAllListeners('request');
            page.removeAllListeners('response');
            page.removeAllListeners('console');
          }

          this.html = await Promise.race([
            page.content(),
            RejectAfter(10000, 'Unrecoverable timeout error'),
          ]);

          // eslint-disable-next-line no-undef
          const links = await page.evaluateHandle(() => Array.from(document.getElementsByTagName('a')).map(({
            hash, hostname, href, pathname, protocol, rel, search,
          }) => ({
            hash,
            hostname,
            href,
            pathname,
            protocol,
            rel,
            search,
          })));

          this.links = await links.jsonValue();
          await links.dispose();

          const formLinks = await Promise.race([
            getLinksFromForms(page), ResolveAfter(3000, []),
          ]);
          if (formLinks && formLinks.length > 0) {
            this.log(`Found ${formLinks.length} form links`, 'driver', 'error');
            this.links = this.links.concat(formLinks);
          }

          // eslint-disable-next-line no-undef
          const scripts = await page.evaluateHandle(() => Array.from(document.getElementsByTagName('script')).map(({
            src,
          }) => src));

          this.scripts = (await scripts.jsonValue()).filter(script => script);
          await scripts.dispose();

          this.js = await page.evaluate(getJsRecursive);
          if (!this.js) {
            this.js = await page.evaluate(getJs);
          }

          this.cookies = (await page.cookies()).map(({
            name, value, domain, path,
          }) => ({
            name, value, domain, path,
          }));

          if (screenshot) {
            await this.screenshotTimeout(page);
          }

          if (Object.keys(this.pageTexts).length < 6) {
            try {
              const metas = await extractMetadata(this.html, url);

              await Promise.all([
                this.extractPageTextFromMetas(metas, first),
                this.extractSecondaryTitleFromHtml(this.html),
              ]);
              await this.extractPageTextFromHtml(this.html);
            } catch (e) {
              this.log(`Failed extracting json-ld: ${e.message}`, 'driver', 'error');
            }
          }

          resolve();
        } catch (error) {
          if (error instanceof InvalidRedirectError) {
            reject(error);
          } else {
            reject(new Error(`visit error: ${error.message || error}`));
          }
        }
      });
    } catch (error) {
      this.log(`visit error: ${error.message || error} (${url})`, 'error');
      if (error instanceof InvalidRedirectError) {
        throw error;
      } else {
        throw new Error(error.message || error.toString());
      }
    } finally {
      done = true;

      if (browser) {
        browser.removeAllListeners('disconnected');
        try {
          await browser.close();

          this.log('browser close ok', 'info');
        } catch (error) {
          this.log(`browser close error: ${error.message || error}`, 'error');
        }
      }
    }

    this.log(`visit ok (${url})`, 'info');
  }

  async screenshotTimeout(page) {
    try {
      await page.waitFor(3 * 1000);
      this.screenshot = await Promise.race([
        page.screenshot({
          encoding: 'binary',
          type: 'jpeg',
        }),
        RejectAfter(5000, 'Failed taking screenshot'),
      ]);
    } catch (error) {
      this.log(error.message || error, 'error');
    }
  }

  async extractPageTextFromMetas(metas, first) {
    if (!Object.prototype.hasOwnProperty.call(this.pageTexts, 'title')) {
      const titleString = PageTextHelper.titleStringMetas(metas);
      if (titleString) {
        Object.assign(this.pageTexts, { title: titleString });
      }
    }
    if (!Object.prototype.hasOwnProperty.call(this.pageTexts, 'description')) {
      const descriptionString = PageTextHelper.descriptionStringMetas(metas);
      if (descriptionString) {
        Object.assign(this.pageTexts, { description: descriptionString });
      }
    }
    if (!Object.prototype.hasOwnProperty.call(this.pageTexts, 'site_name')) {
      const siteNameString = PageTextHelper.siteNameStringMetas(metas);
      if (siteNameString) {
        Object.assign(this.pageTexts, { site_name: siteNameString });
      }
    }
    if (first && Object.prototype.hasOwnProperty.call(metas, 'jsonld')) {
      Object.assign(this.pageTexts, { jsonld: metas.jsonld });
    }
  }

  async extractSecondaryTitleFromHtml(fullHtml) {
    if (Object.prototype.hasOwnProperty.call(this.pageTexts, 'secondary_title')) {
      return;
    }

    try {
      const descSecondaryString = await extractSecondaryTitle(fullHtml);
      if (descSecondaryString) {
        Object.assign(this.pageTexts, { secondary_title: descSecondaryString });
      }
    } catch (e) {
      this.log(`Failed secondary page text: ${e.message}`, 'driver', 'error');
    }
  }

  async extractPageTextFromHtml(fullHtml) {
    if (Object.prototype.hasOwnProperty.call(this.pageTexts, 'page_text')) {
      return;
    }
    try {
      const text = await extractPageText(fullHtml);
      const pageText = `${this.pageTexts.title || ''} ${this.pageTexts.description || ''} ${text}`;

      let textBuffer;
      if (Buffer.byteLength(pageText, 'utf8') > 65534) {
        textBuffer = Buffer.alloc(65534);
        textBuffer.write(pageText);
      } else {
        textBuffer = Buffer.from(pageText);
      }

      Object.assign(this.pageTexts, { page_text: textBuffer.toString() });
    } catch (e) {
      this.log(`Failed page text: ${e.message}`, 'driver', 'error');
    }
  }
}

module.exports = Puppeteer
module.exports.getJsRecursive = getJsRecursive;
module.exports.getJs = getJs;
