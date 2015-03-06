var request = require('superagent');
var stringify = require('json-stable-stringify');

// todo: proxy data.id onto this

function GitHubGist(data, options) {
  options || (options = {});
  this.data = typeof data === 'object' ? data || {} : {id: data};
  this._authorization =
    options.oauthToken ? 'token ' + options.oauthToken :
      GitHubGist.defaultAuthorization;
}

GitHubGist.rootURL = 'https://api.github.com';
GitHubGist.defaultAuthorization = null;
GitHubGist.fetchSize = 10;

GitHubGist.prototype.fetch = function (callback) {
  var r = request
    .get(GitHubGist.rootURL + '/gists/' + this.data.id)
    .set('Accept', 'application/vnd.github.v3+json');
  if (this._authorization) {
    r.set('Authorization', this._authorization);
  }
  var self = this;
  r.end(function (err, res) {
    if (err || res.error) {
      return callback(err || res.error);
    }
    self.parse(res, function () {
      if (self._authorization) {
        self._syncRemote(callback);
      } else {
        callback.apply(null, arguments);
      }
    });
  });
};

GitHubGist.prototype._syncRemote = function (callback) {
  var self = this;
  var version = this.data.version;
  var changes = [];
  function lookForTheLastKnownComment(comments) {
    return comments.reverse().some(function (comment) {
      if (comment.id === version) {
        return true;
      } else {
        try {
          changes.push({
            id: comment.id,
            body: JSON.parse(comment.body)
          });
        } catch (e) {
          // skip
        }
        return false;
      }
    });
  }
  function applyPendingChangesAndCommit() {
    if (!changes.length) {
      return callback(null, self);
    }
    changes.reverse()
      .forEach(function (comment) {
        self.patch(comment.body);
        self.data.version = comment.id;
      });
    request
      .patch(GitHubGist.rootURL + '/gists/' + self.data.id)
      .send(self.toJSON())
      .set('Accept', 'application/vnd.github.v3+json')
      .set('Authorization', self._authorization)
      .end(function (err, res) {
        self.data._removed = null;
        if (err || res.error) {
          return callback(err || res.error);
        }
        self.parse(res, callback);
      });
  }
  // gists/:gist_id/comments resource does not support ?page=last or ?order=desc
  // so we are going to resolve index of the last page and go back until
  // change corresponding to data.version is found
  request
    .get(GitHubGist.rootURL + '/gists/' + self.data.id +
      '/comments?per_page=1')
    .set('Accept', 'application/vnd.github.v3+json')
    .set('Authorization', self._authorization)
    .end(function (err, res) {
      if (err || res.error) {
        return callback(err || res.error);
      }
      var link = res.headers['link'];
      var lastPageIndex;
      if (link) {
        lastPageIndex = (/page=(\d+)>; rel="last"/g).exec(link);
        lastPageIndex && (lastPageIndex =
          Math.ceil(parseInt(lastPageIndex[1], 10) / GitHubGist.fetchSize));
      }
      if (lastPageIndex) {
        (function previousPage(page) {
          request
            .get(GitHubGist.rootURL + '/gists/' + self.data.id +
              '/comments?per_page=' + GitHubGist.fetchSize + '&page=' + page)
            .set('Accept', 'application/vnd.github.v3+json')
            .set('Authorization', self._authorization)
            .end(function (err, res) {
              if (err || res.error) {
                return callback(err || res.error);
              }
              page--;
              var terminate = lookForTheLastKnownComment(res.body);
              if (terminate || !page) {
                applyPendingChangesAndCommit();
              } else {
                previousPage(page);
              }
            });
        }(lastPageIndex));
      } else {
        // there is a single page and we are already on it
        lookForTheLastKnownComment(res.body);
        applyPendingChangesAndCommit();
      }
    });
};

GitHubGist.prototype.parse = function (res, callback) {
  if (res.body.description !== 'strkio::set') {
    return callback(new Error('Not a valid strkio set'));
  }
  var self = this;
  var streaks = [];
  function processFileContent(id, jsonString, nextFile) {
    try {
      var streak = JSON.parse(jsonString);
      streak.name = id;
      streaks.push(streak);
      setTimeout(nextFile, 0);
    } catch (e) {
      callback(e);
    }
  }
  var files = res.body.files;
  var fileNames = Object.keys(files);
  (function nextFile() {
    var fileName = fileNames.pop();
    if (fileName) {
      // skip file names starting with _
      if (!fileName.indexOf('_')) {
        return nextFile();
      }
      var file = files[fileName];
      if (file.truncated) {
        request.get(file['raw_url'], function (err, res) {
          if (err || res.error) {
            return callback(err || res.error);
          }
          processFileContent(fileName, res.text, nextFile);
        });
      } else {
        processFileContent(fileName, file.content, nextFile);
      }
    } else {
      self.data = {
        id: res.body.id,
        owner: res.body.owner.login,
        streaks: streaks
      };
      try {
        var meta = JSON.parse(files['_meta'].content);
        self.data.version = meta.version;
      } catch (e) {
        // fixme: this is bad
        // expected right after POST /gists
      }
      callback(null, self);
    }
  }());
};

GitHubGist.prototype.toJSON = function () {
  var data = this.data;
  var json = {
    description: 'strkio::set',
    files: {}
  };
  data.streaks.forEach(function (streak) {
    json.files[streak.name] = {
      content: stringify(streak)
    };
  });
  data._removed && data._removed.forEach(function (streakName) {
    json.files[streakName] = null;
  });
  var meta = {};
  data.version && (meta.version = data.version);
  json.files._meta = {content: stringify(meta)};
  return json;
};

GitHubGist.prototype.save = function (data, callback) {
  if (!this._authorization) {
    return callback(new Error('Unauthorized'));
  }
  var self = this;
  if (typeof data === 'function') {
    callback = data;
    request
      .post(GitHubGist.rootURL + '/gists')
      .send(this.toJSON())
      .set('Accept', 'application/vnd.github.v3+json')
      .set('Authorization', self._authorization)
      .end(function (err, res) {
        if (err || res.error) {
          return callback(err || res.error);
        }
        self.parse(res, callback);
      });
  } else {
    var diff = this.diff(data);
    if (Object.keys(diff).length) {
      request
        .post(GitHubGist.rootURL + '/gists/' + this.data.id +
          '/comments')
        .send({
          body: stringify(diff)
        })
        .set('Accept', 'application/vnd.github.v3+json')
        .set('Authorization', self._authorization)
        .end(function (err, res) {
          if (err || res.error) {
            return callback(err || res.error);
          }
          self.data = data;
          callback(null, self);
        });
    } else {
      callback(null, self);
    }
  }
};

function byName(obj, streak) {
  obj[streak.name] = streak;
  return obj;
}

// fixme: slowest implementation possible
function substract(l, r) {
  return l.filter(function (v) {return !~r.indexOf(v);});
}

function deepEqual(l, r, k) {
  return Array.isArray(l[k]) || Array.isArray(r[k]) ?
  stringify(l[k]) === stringify(r[k]) : l[k] === r[k];
}

function diff(l, r) {
  var d = {};
  Object.keys(l).concat(Object.keys(r)).forEach(function (k) {
    // skip keys starting with _
    if (k !== 'data' && k.indexOf('_')) {
      deepEqual(l, r, k) || (d[k] = r[k]);
    }
  });
  var ld = l.data || {};
  var ldk = Object.keys(ld);
  var rd = r.data || {};
  var rdk = Object.keys(rd);
  var data = {};
  ldk.forEach(function (k) {
    var diff = (rd[k] || 0) - ld[k];
    diff && (data[k] = (diff > 0 ? '+' : '-') + Math.abs(diff));
  });
  var rld = substract(rdk, ldk);
  rld.forEach(function (k) {
    data[k] = (rd[k] > 0 ? '+' : '-') + Math.abs(rd[k]);
  });
  if (Object.keys(data).length) {
    d.data = data;
  }
  return d;
}

GitHubGist.prototype.diff = function (r) {
  var d = {};
  var l = this.data;
  var ld = l.streaks.reduce(byName, {});
  var ldk = Object.keys(ld);
  var rd = r.streaks.reduce(byName, {});
  var rdk = Object.keys(rd);
  ldk.forEach(function (n) {
    if (rd[n]) {
      // streak modified
      var lrd = diff(ld[n], rd[n]);
      if (Object.keys(lrd).length) {
        d[n] = lrd;
      }
    } else {
      // streak removed
      d[n] = null;
    }
  });
  var rld = substract(rdk, ldk);
  rld.forEach(function (n) {
    // streak added
    d[n] = rd[n];
  });
  return d;
};

function patch(streak, diff) {
  Object.keys(diff).forEach(function (k) {
    if (k === 'data') {
      var sd = streak.data;
      var dd = diff.data;
      Object.keys(dd).forEach(function (key) {
        var ddv = dd[key];
        if (typeof ddv === 'string') {
          sd[key] = (sd[key] || 0) + parseInt(ddv, 10);
        } else {
          sd[key] = ddv;
        }
        sd[key] || (delete sd[key]);
      });
    } else {
      streak[k] = diff[k];
    }
  });
  return streak;
}

GitHubGist.prototype.patch = function (diff) {
  var streaks = this.data.streaks;
  var removed = this.data._removed || (this.data._removed = []);
  for (var i = streaks.length - 1; i > -1; i--) {
    var streak = streaks[i];
    if (diff.hasOwnProperty(streak.name)) {
      if (diff[streak.name]) {
        patch(streak, diff[streak.name]);
      } else {
        removed.push(streaks.splice(i, 1)[0].name);
      }
    }
  }
  var addedStreaks = substract(Object.keys(diff),
    streaks.map(function (streak) {return streak.name;}));
  addedStreaks.forEach(function (name) {
    diff[name] && (streaks.push(patch({name: name, data: {}}, diff[name])));
  });
  return this.data;
};

module.exports = GitHubGist;
