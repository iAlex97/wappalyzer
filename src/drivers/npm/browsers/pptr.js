const Browser = require('./puppeteer');
const InvalidRedirectError = require('../errors/InvalidRedirectError');

if (process.argv.length < 4) {
  process.exit(1);
}

const [, , mUrl, mFlags, mOptions] = process.argv;
const { simple, screenshot, first } = JSON.parse(mFlags);
const options = JSON.parse(mOptions);

const browser = new Browser(options);
browser.log = (message, type) => {
  process.send({
    type: 'log',
    data: {
      message: `[${process.pid}] ${message}`,
      source: 'browser',
      type,
    },
  });
};

const ipc = (type, data) => new Promise((resolve, reject) => {
  process.send({ type, data }, (err) => {
    if (err) {
      reject(err);
    } else {
      resolve();
    }
  });
});

const unhandledRejectionHandler = (error) => {
  browser.log(`page ${mUrl} error: ${error.message || error}`, 'error');
  process.exit(10);
};
process.on('unhandledRejection', unhandledRejectionHandler);

(async () => {
  try {
    await browser.visit(mUrl, screenshot, simple, first);
    const {
      cookies, headers, scripts, js, html, links, statusCode, pageTexts,
    } = browser;

    if (browser.screenshot) {
      try {
        await ipc('ss', browser.screenshot);
      } catch (e) {
        browser.log('Screenshot IPC failed', 'error');
      }
    }

    await ipc('data', {
      cookies, headers, scripts, js, html, links, statusCode, pageTexts,
    });

    process.exit(0);
  } catch (error) {
    browser.log(`page ${mUrl} error: ${error.message || error}`, 'error');

    Object.assign(error, { type: error instanceof InvalidRedirectError ? 'redirect' : 'generic' });
    await ipc('error', error);

    process.exit(2);
  } finally {
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
  }
})();
