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
  let inhibit = false;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === 'script' || name === 'style') {
        inhibit = true;
      } else if (name === 'li') {
        result += '- ';
      }
    },
    ontext(text) {
      if (!inhibit) {
        const trimmed = text.trim();
        if (trimmed !== '') {
          result += `${trimmed} `;
        }
      }
    },
    onclosetag(tagname) {
      if (tagname === 'script' || tagname === 'style') {
        inhibit = false;
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
