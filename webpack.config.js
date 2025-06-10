//@ts-check
'use strict';

const path = require('path');
// const CopyWebpackPlugin = require('copy-webpack-plugin'); // Keep if you might add webviews

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node',
  mode: 'none', // 'production' for packaging, 'development' for watch

  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js'] // Removed .html as we don't have HTML for this basic version
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
      // Removed html-loader rule
    ]
  },
  // plugins: [ // Keep if you might add webviews
  //   new CopyWebpackPlugin({
  //     patterns: [
  //       {
  //         from: 'src/webview', // Example
  //         to: 'webview',
  //         globOptions: {
  //           ignore: ['**/.DS_Store']
  //         }
  //       }
  //     ]
  //   })
  // ],
  devtool: 'nosources-source-map', // 'source-map' for development
  infrastructureLogging: {
    level: "log",
  },
};

module.exports = [ extensionConfig ];