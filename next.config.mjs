import { imageHosts } from './image-hosts.config.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  productionBrowserSourceMaps: true,
  distDir: process.env.DIST_DIR || '.next',

  // Native / WASM document processors must run as plain Node modules, not be bundled.
  serverExternalPackages: ['pdfjs-dist', 'tesseract.js', 'mammoth', '@napi-rs/canvas'],

  eslint: {
    ignoreDuringBuilds: true,
  },

  images: {
    remotePatterns: imageHosts,
    minimumCacheTTL: 60,
    qualities: [75, 85, 100],
  },

  webpack(config, { dev }) {
if (dev) {
  config.module.rules.push({
    test: /\.(jsx|tsx)$/,
    exclude: [/node_modules/],
    use: [{
      loader: '@dhiwise/component-tagger/nextLoader',
    }],
  });
  const ignoredPaths = (process.env.WATCH_IGNORED_PATHS || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  config.watchOptions = {
    ignored: ignoredPaths.length
      ? ignoredPaths.map((p) => `**/${p.replace(/^\/+|\/+$/g, '')}/**`)
      : undefined,
  };
}

    return config;
  }
};
export default nextConfig;