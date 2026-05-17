const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  app.use(
    '/tmdb-images',
    createProxyMiddleware({
      target: 'https://image.tmdb.org',
      changeOrigin: true,
      pathRewrite: { '^/tmdb-images': '' },
    })
  );
};
