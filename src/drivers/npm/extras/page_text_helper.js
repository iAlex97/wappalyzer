const blacklistedSiteNames = ['mysite', 'website', 'home', ' ', 'classy', 'blog', 'default store view', 'default',
  'website-1', 'my site', 'welcome', 'english', 'my blog', 'mysite-1', 'blank title', 'online store', 'my website',
  'your site title', 'my cms', 'gitlab', 'jalbum', 'yelp', 'newsite', 'tumblr', 'main', 'custom logo cases',
  'getty images', 'mysite 1', 'news', 'airbnb', 'en', 'startseite', '.', '{$plugin.tx_news.opengraph.site_name}',
  'monsite', 'medium', 'land rover configurator', 'your site name goes here', 'perfect test site', 'help center',
  'homepage', 'mynewsdesk', 'mysite-2', 'nextcloud', 'site name', 'site', 'portal', 'salon', 'test', 'shopify',
  'support', 'vimeo', 'google docs', 'printing & more', 'pinterest', 'classic-layout', 'a wordpress site',
  'meinewebsite', '-customer value-', 'youtube', 'website-2', 'construction-company', 'home page', 'default site',
  'main website', 'my wordpress', '/', 'start', 'facebook'];

const getTextForXPath = async (page, xpath, attribute = 'textContent') => {
  const elements = await page.$x(xpath);
  const tempProperties = await Promise.all(elements.map(element => element.getProperty(attribute)));
  const tempTexts = await Promise.all(tempProperties.map(property => property.jsonValue()));
  const texts = [];

  elements.forEach(e => e.dispose());
  tempProperties.forEach(p => p.dispose());

  tempTexts.forEach((tempText) => {
    if (tempText && !texts.includes(tempText.trim())) {
      texts.push(tempText.trim());
    }
  });

  if (texts.length === 1) {
    return texts[0];
  }
  if (texts.length > 1) {
    return texts.join(' ');
  }
  return '';
};

class PageTextHelper {
  static async titleString(page) {
    let titleString = await getTextForXPath(page, '//head/title');
    if (!titleString) {
      titleString = await getTextForXPath(page, '//head/meta[@property="og:title"]', 'content');
    }
    if (!titleString) {
      titleString = await getTextForXPath(page, '//meta[contains(@property, "title")]', 'content');
    }

    return titleString.trim().substring(0, 250);
  }

  static async siteNameString(page) {
    const siteName = (await getTextForXPath(page, "//head/meta[@property='og:site_name']", 'content'));
    if (blacklistedSiteNames.includes(siteName.toLowerCase())) {
      return null;
    }
    return siteName.trim().substring(0, 250);
  }

  static async secondaryTitleString(page) {
    const descXpaths = ['//h1', '//h2'];
    let descriptionString = '';
    for (const xpath of descXpaths) {
      descriptionString = await getTextForXPath(page, xpath);
      if (descriptionString) {
        break;
      }
    }
    return descriptionString.trim().substring(0, 250);
  }

  static async descriptionString(page) {
    let descriptionString = '';

    const descXpaths = ["//head/meta[@name='description']", "//head/meta[@property='og:description']", '//meta[contains(@name, "desc")]',
      '//meta[contains(@property, "desc")]', '//meta[contains(@name, "DESC")]', '//meta[contains(@name, "Desc")]'];
    for (const xpath of descXpaths) {
      descriptionString = await getTextForXPath(page, xpath, 'content');
      if (descriptionString) {
        break;
      }
    }

    return descriptionString.trim().substring(0, 250);
  }
}

module.exports = PageTextHelper;
