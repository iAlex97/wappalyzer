const blacklistedSiteNames = ['mysite', 'website', 'home', ' ', 'classy', 'blog', 'default store view', 'default',
  'website-1', 'my site', 'welcome', 'english', 'my blog', 'mysite-1', 'blank title', 'online store', 'my website',
  'your site title', 'my cms', 'gitlab', 'jalbum', 'yelp', 'newsite', 'tumblr', 'main', 'custom logo cases',
  'getty images', 'mysite 1', 'news', 'airbnb', 'en', 'startseite', '.', '{$plugin.tx_news.opengraph.site_name}',
  'monsite', 'medium', 'land rover configurator', 'your site name goes here', 'perfect test site', 'help center',
  'homepage', 'mynewsdesk', 'mysite-2', 'nextcloud', 'site name', 'site', 'portal', 'salon', 'test', 'shopify',
  'support', 'vimeo', 'google docs', 'printing & more', 'pinterest', 'classic-layout', 'a wordpress site',
  'meinewebsite', '-customer value-', 'youtube', 'website-2', 'construction-company', 'home page', 'default site',
  'main website', 'my wordpress', '/', 'start', 'facebook'];

class PageTextHelper {
  static titleStringMetas(metas) {
    let titleString = '';
    if (metas.html && metas.html.title) {
      titleString = metas.html.title;
    }
    if (!titleString && metas.twitter && metas.twitter.title) {
      titleString = metas.twitter.title;
    }
    if (!titleString && metas.jsonld && Array.isArray(metas.jsonld)) {
      titleString = this.findKeyInIterable(metas.jsonld, 'title');
    }
    if (!titleString && metas.rdfa && Array.isArray(metas.rdfa)) {
      titleString = this.findKeyInIterable(metas.rdfa, 'og:title');
    }
    if (!titleString && metas.microdata && Array.isArray(metas.microdata)) {
      titleString = this.findKeyInIterable(metas.microdata, 'title');
    }
    return titleString.trim().substring(0, 250);
  }

  static siteNameStringMetas(metas) {
    let siteNameString = '';
    if (!siteNameString && metas.rdfa && Array.isArray(metas.rdfa)) {
      siteNameString = this.findKeyInIterable(metas.rdfa, 'og:site_name');
    }
    if (!siteNameString && metas.jsonld && Array.isArray(metas.jsonld)) {
      siteNameString = this.findKeyInIterable(metas.jsonld, 'name');
    }
    if (!siteNameString && metas.microdata && Array.isArray(metas.microdata)) {
      siteNameString = this.findKeyInIterable(metas.microdata, 'name');
    }
    if (blacklistedSiteNames.includes(siteNameString.toLowerCase())) {
      return null;
    }
    return siteNameString.trim().substring(0, 250);
  }

  static descriptionStringMetas(metas) {
    let descriptionString = '';
    if (metas.html && metas.html.description) {
      descriptionString = metas.html.description;
    }
    if (!descriptionString && metas.twitter && metas.twitter.description) {
      descriptionString = metas.twitter.description;
    }
    if (!descriptionString && metas.jsonld && Array.isArray(metas.jsonld)) {
      descriptionString = this.findKeyInIterable(metas.jsonld, 'description');
    }
    if (!descriptionString && metas.rdfa && Array.isArray(metas.rdfa)) {
      descriptionString = this.findKeyInIterable(metas.rdfa, 'og:description');
    }
    if (!descriptionString && metas.microdata && Array.isArray(metas.microdata)) {
      descriptionString = this.findKeyInIterable(metas.microdata, 'description');
    }
    return descriptionString.trim().substring(0, 250);
  }

  static findKeyInIterable(arr, key) {
    // eslint-disable-next-line no-restricted-syntax
    for (const elem of arr) {
      if (!Object.prototype.hasOwnProperty.call(elem, key)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (Array.isArray(elem[key])) {
        // eslint-disable-next-line no-restricted-syntax
        for (const val of elem[key]) {
          if (Object.prototype.hasOwnProperty.call(val, '@value')) {
            return val['@value'];
          }
        }
      } else if (typeof elem[key] === 'string') {
        return elem[key];
      }
    }
    return '';
  }
}

module.exports = PageTextHelper;
