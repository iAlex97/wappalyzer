const Driver = require('./driver');
const Puppeteer = require('./browsers/puppeteer');

class Wappalyzer {
  constructor(pageUrl, options) {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const Browser = require(`./browser`);

    return new Driver(Browser, pageUrl, options);
  }
}

module.exports.Wappalyzer = Wappalyzer;
module.exports.Puppeteer = Puppeteer;
module.exports.Driver = Driver;