
module.exports.RejectAfter = (ms, message) => new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(message)), ms);
});

module.exports.ResolveAfter = (ms) => new Promise((resolve, _) => setTimeout(() => resolve, ms));
