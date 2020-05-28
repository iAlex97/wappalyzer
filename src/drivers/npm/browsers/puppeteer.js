const { TimeoutError } = require('puppeteer/lib/Errors');

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
  puppeteer = require('puppeteer');
}

const Browser = require('../browser');

function getJs() {
  const dereference = (obj, level = 0) => {
    try {
      // eslint-disable-next-line no-undef
      if (level > 5 || (level && obj === window)) {
        return '[Removed]';
      }

      if (Array.isArray(obj)) {
        obj = obj.map(item => dereference(item, level + 1));
      }

      if (typeof obj === 'function' || (typeof obj === 'object' && obj !== null)) {
        const newObj = {};

        Object.keys(obj).forEach((key) => {
          newObj[key] = dereference(obj[key], level + 1);
        });

        return newObj;
      }

      return obj;
    } catch (error) {
      return undefined;
    }
  };

  // eslint-disable-next-line no-undef
  return dereference(window);
}

class PuppeteerBrowser extends Browser {
  constructor(options) {
    options.maxWait = options.maxWait || 60;

    super(options);
    this.ssAlowedResources = ['image', 'stylesheet', 'document', 'script'];
    this.defAlowedResources = ['document', 'script'];
  }

  async visit(url, hook) {
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
          });

          browser.on('disconnected', () => {
            if (!done) {
              reject(new Error('browser: disconnected'));
            }
          });

          const page = await browser.newPage();
          const screenshot = await hook(page, 0);

          page.setDefaultTimeout(this.options.maxWait * 1.1);

          await page.setRequestInterception(true);

          page.on('error', error => reject(new Error(`page error: ${error.message || error}`)));

          let responseReceived = false;

          page.on('request', (request) => {
            try {
              if (
                responseReceived
                && request.isNavigationRequest()
                && request.frame() === page.mainFrame()
                && request.url() !== url
              ) {
                this.log(`abort navigation to ${request.url()}`);

                request.abort('aborted');
              } else if (!done) {
                const allowed = screenshot ? this.ssAlowedResources : this.defAlowedResources;
                if (!allowed.includes(request.resourceType())) {
                  request.abort();
                } else {
                  request.continue();
                }
              }
            } catch (error) {
              reject(new Error(`page error: ${error.message || error}`));
            }
          });

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
              }
            } catch (error) {
              reject(new Error(`page error: ${error.message || error}`));
            }
          });

          page.on('console', ({ _type, _text, _location }) => {
            if (!/Failed to load resource: net::ERR_FAILED/.test(_text)) {
              this.log(`${_text} (${_location.url}: ${_location.lineNumber})`, _type);
            }
          });

          if (this.options.userAgent) {
            await page.setUserAgent(this.options.userAgent);
          }

          try {
            await Promise.race([
              page.goto(url, { waitUntil: ['load', 'networkidle0'], timeout: this.options.maxWait - 100 }),
              // eslint-disable-next-line no-shadow
              new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), this.options.maxWait)),
            ]);
          } catch (error) {
            if (!(error instanceof TimeoutError)) {
              throw new Error(error.message || error.toString());
            } else {
              await Promise.race([
                page.content(),
                // eslint-disable-next-line no-shadow
                new Promise((resolve, reject) => setTimeout(() => reject(new Error('Unrecoverable timeout error')), 5000)),
              ]);
              this.log('Ignored timeout error');
            }
          } finally {
            page.removeAllListeners('error');
            page.removeAllListeners('request');
            page.removeAllListeners('response');
            page.removeAllListeners('console');
          }

          // eslint-disable-next-line no-undef
          const links = await page.evaluateHandle(() => Array.from(document.getElementsByTagName('a')).map(({
            hash, hostname, href, pathname, protocol, rel,
          }) => ({
            hash,
            hostname,
            href,
            pathname,
            protocol,
            rel,
          })));

          this.links = await links.jsonValue();
          await links.dispose();

          // eslint-disable-next-line no-undef
          const scripts = await page.evaluateHandle(() => Array.from(document.getElementsByTagName('script')).map(({
            src,
          }) => src));

          this.scripts = (await scripts.jsonValue()).filter(script => script);
          await scripts.dispose();

          this.js = await page.evaluate(getJs);

          this.cookies = (await page.cookies()).map(({
            name, value, domain, path,
          }) => ({
            name, value, domain, path,
          }));

          this.html = await page.content();
          if (hook) try { await hook(page, 1); } catch (e) { this.log(`page hook exception: ${e.message || e}`); }

          resolve();
        } catch (error) {
          reject(new Error(`visit error: ${error.message || error}`));
        }
      });
    } catch (error) {
      this.log(`visit error: ${error.message || error} (${url})`, 'error');

      throw new Error(error.message || error.toString());
    } finally {
      done = true;

      if (browser) {
        browser.removeAllListeners('disconnected');
        try {
          await browser.close();

          this.log('browser close ok');
        } catch (error) {
          this.log(`browser close error: ${error.message || error}`, 'error');
        }
      }
    }

    this.log(`visit ok (${url})`);
  }
}

module.exports = PuppeteerBrowser;
