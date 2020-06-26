class InvalidRedirectError extends Error {
  constructor(originalUrl, redirectUrl) {
    super(`Invalid redirect from ${originalUrl} to ${redirectUrl}`);
    this.originalUrl = originalUrl;
    this.redirectUrl = redirectUrl;
  }
}

module.exports = InvalidRedirectError;
