const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

// Load .env if present (fall back to empty strings)
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  entry: {
    background: './src/background/background.ts',
    overlay: './src/overlay/overlay.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: '[name]/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  plugins: [
    new webpack.DefinePlugin({
      __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ''),
      __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
    }),
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'icons', to: 'icons' },
        { from: 'src/background/background.html', to: 'background/' },
        { from: 'src/overlay/overlay.html', to: 'overlay/' },
        { from: 'src/overlay/overlay.css', to: 'overlay/' },
        // Champion classifier model + labels
        { from: 'models/champion_classifier.onnx', to: 'models/' },
        { from: 'models/champion_labels.json', to: 'models/' },
        // ONNX Runtime WASM + MJS loader files (both required for WASM backend)
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm', to: 'background/[name][ext]' },
        { from: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs', to: 'background/[name][ext]' },
        // RNNoise WASM (noise suppression + VAD)
        { from: 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', to: 'background/' },
      ],
    }),
  ],
};
