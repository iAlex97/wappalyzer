const { Handler } = require('htmlmetaparser');
const { Parser } = require('htmlparser2');

module.exports.RejectAfter = (ms, message) => new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(message)), ms);
});

module.exports.ResolveAfter = ms => new Promise(resolve => setTimeout(() => resolve, ms));

module.exports.extractMetadata = (html, url) => new Promise((resolve, reject) => {
  const handler = new Handler(
    (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    }, {
      url, // The HTML pages URL is used to resolve relative URLs.
    },
  );

  // Create a HTML parser with the handler.
  const parser = new Parser(handler, { decodeEntities: true });
  parser.write(html);
  parser.done();
});

module.exports.extractPageText = html => new Promise((resolve, reject) => {
  let result = '';
  const inhibit = {};
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === 'script' || name === 'style' || name === 'head') {
        inhibit[name] = true;
      } else if (name === 'li') {
        result += '- ';
      }
    },
    ontext(text) {
      const inh = Object.values(inhibit).reduce((prev, current) => prev || current, false);
      if (!inh) {
        const trimmed = text.trim();
        if (trimmed !== '') {
          result += `${trimmed} `;
        }
      }
    },
    onclosetag(tagname) {
      if (tagname === 'script' || tagname === 'style' || tagname === 'head') {
        inhibit[tagname] = false;
      }
    },
    onend() {
      resolve(result);
    },
    onerror(error) {
      reject(error);
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
});

module.exports.extractSecondaryTitle = html => new Promise((resolve, reject) => {
  let result = '';
  let inhibit = true;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === 'h1' || name === 'h2') {
        inhibit = false;
      }
    },
    ontext(text) {
      if (!inhibit) {
        const trimmed = text.trim().substring(0, 250);
        if (trimmed && trimmed.length > 3) {
          result = trimmed;
        }
      }
    },
    onclosetag(tagname) {
      if (tagname === 'h1' || tagname === 'h2') {
        inhibit = true;
      }
    },
    onend() {
      resolve(result);
    },
    onerror(error) {
      reject(error);
    },
  }, { decodeEntities: true });
  parser.write(html);
  parser.end();
});
