const Browser = require('./puppeteer');

if (process.argv.length < 6) {
  process.exit(1);
}

const [, , mUrl, mSimple, mScreenshot, mFirst, mOptions] = process.argv;
const simple = mSimple === 'true';
const screenshot = mScreenshot === 'true';
const first = mFirst === 'true';
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
    process.exit(2);
  } finally {
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
  }
})();
