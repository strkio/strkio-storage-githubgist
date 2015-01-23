# strkio-storage-githubgist

GitHub Gist as a [strk.io](http://strk.io/) storage.

## Installation

```sh
npm install strkio-storage-githubgist --save
```

## Usage

```js
var GitHubGist = require('strkio-storage-githubgist');
var gist = GitHubGist({id: '<gist id>'}, {accessToken: '<access token>'});
gist.fetch(function (err, self) {
  self.data.streaks.forEach(function(streak) {
    streak.data['2015-01-18'] = 1;
  });
  ...
  self.save(function (err, self) {
    ...
  });
});
```

## Development

```sh
npm run lint # check JS files with jscs and jshint
npm test # run test/**/*.spec.js
npm run validate # lint & test 
```

## License

[MIT License](http://opensource.org/licenses/mit-license.php).
