var expect = require('chai').expect;

var restify = require('restify');

var stringify = require('json-stable-stringify');
var GitHubGist = require('../src/GitHubGist');

function HttpServerMock(port, callback) {
  this.server = restify.createServer({name: 'http-server-mock'});

  this.server.use(restify.queryParser());
  this.server.use(restify.bodyParser());

  this.server.listen(port, callback);
}

HttpServerMock.prototype.whenRequested = function (method, url, cb) {
  var log = this.log;
  var server = this.server;
  return {
    thenRespond: function (o) {
      log[method + ' ' + url] = o;
      var of = typeof o === 'function' ? o :
        function (req, res) {
          if (o.status) {
            res.status(o.status);
          }
          if (o.headers) {
            Object.keys(o.headers).forEach(function (key) {
              res.set(key, o.headers[key]);
            });
          }
          if (o.json) {
            res.json(o.json);
          }
        };
      var handler = server[method](url, function (req, res) {
        cb && (cb(req.body));
        if (!of(req, res)) {
          server.rm(handler);
          delete log[method + ' ' + url];
        }
      });
    }
  };
};

HttpServerMock.prototype.expectNoMoreInteractions = function () {
  expect(Object.keys(this.log)).to.be.empty();
};

HttpServerMock.prototype.reset = function () {
  this.log = {};
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

describe('GitHubGist', function () {

  var github;

  before(function (done) {
    github = new HttpServerMock(4000, function () {
      GitHubGist.rootURL = 'http://localhost:4000';
      GitHubGist.defaultAuthorization = 'provided';
      GitHubGist.fetchSize = 3;
      done();
    });
  });

  beforeEach(function () {
    github.reset();
  });

  describe('#save()', function () {

    it('should create a new set if no id is provided', function (done) {
      github.whenRequested('post', '/gists').thenRespond({
        status: 201,
        json: {
          id: 'gist_id',
          description: 'strkio::set',
          owner: {
            login: 'bob'
          },
          files: {
            'streak_name': {
              content: stringify(
                {name: 'streak_name', description: '', data: {}}
              )
            }
          }
        }
      });
      var data = {
        streaks: [
          {name: 'streak_name', description: '', data: {}}
        ]
      };
      new GitHubGist(data).save(function (err, self) {
        expect(err).to.be.null;
        expect(self.data).to.be.deep.equal(
          {
            id: 'gist_id',
            owner: 'bob',
            streaks: [
              {name: 'streak_name', description: '', data: {}}
            ]
          }
        );
        github.expectNoMoreInteractions();
        done();
      });
    });

    it('should update existing set if id is provided', function (done) {
      github.whenRequested('post', '/gists/gist_id/comments').thenRespond({
        status: 201,
        json: {
          id: 'comment_id',
          body: stringify({
            streaks: {
              'streak_name': {description: 'updated_description'}
            }
          })
        }
      });
      var data = {
        id: 'gist_id',
        version: '0',
        streaks: [
          {name: 'streak_name', description: 'description', data: {}}
        ]
      };
      var updatedData = clone(data);
      updatedData.streaks[0].description = 'updated_description';
      new GitHubGist(data).save(updatedData, function (err, self) {
        expect(err).to.be.null;
        expect(self.data).to.be.deep.equal(
          {
            id: 'gist_id',
            version: '0',
            streaks: [
              {
                name: 'streak_name',
                description: 'updated_description',
                data: {}
              }
            ]
          }
        );
        github.expectNoMoreInteractions();
        done();
      });
    });

  });

  describe('#fetch()', function () {

    // todo: rewrite. too hard to read
    it('should automatically sync remote set if it\'s out of sync',
      function (done) {
        github.whenRequested('get', '/gists/gist_id').thenRespond({
          status: 200,
          json: {
            id: 'gist_id',
            description: 'strkio::set',
            owner: {
              login: 'bob'
            },
            files: {
              _meta: {
                content: '{"version": "2"}'
              },
              'streak_name': {
                content: stringify(
                  {name: 'streak_name', description: '',
                    data: {'2012-12-25': 3}}
                )
              },
              'another_streak_name': {
                content: stringify({
                  name: 'another_streak_name',
                  description: 'another_streak_description',
                  data: {}
                })
              }
            }
          }
        });
        var cc = 3;
        github.whenRequested('get', '/gists/gist_id/comments')
          .thenRespond(function (req, res) {
            var page = req.params.page;
            if (page === '2') {
              res.status(200);
              res.set('Link',
                '<https://api.github.com/resource?page=1>; rel="previous",' +
                '<https://api.github.com/resource?page=2>; rel="last"');
              res.json([{
                id: 4,
                body: stringify({
                  'streak_name': {data: {'2012-12-25': 2}}
                })
              }]);
            } else
            if (page === '1') {
              res.status(200);
              res.set('Link',
                '<https://api.github.com/resource?page=2>; rel="next",' +
                '<https://api.github.com/resource?page=2>; rel="last"');
              res.json([{
                id: 1,
                body: stringify({
                  'streak_name': {data: {'2012-12-25': 1}}
                })
              }, {
                id: 2,
                body: stringify({
                  'streak_name': {data: {'2012-12-25': '+2'}}
                })
              }, {
                id: 3,
                body: stringify({
                  'streak_name': {data: {'2012-12-24': '+2'}}
                })
              }]);
            } else {
              if (req.params['per_page'] === '1') {
                res.status(200);
                res.set('Link',
                  '<https://api.github.com/resource?page=2>; rel="next",' +
                  '<https://api.github.com/resource?page=4>; rel="last"');
                res.json([{
                  id: 1,
                  body: stringify({
                    'streak_name': {data: {'2012-12-25': 1}}
                  })
                }]);
              } else {
                res.send(404);
              }
            }
            return --cc;
          });
        var patchPayload;
        github.whenRequested('patch', '/gists/gist_id', function (data) {
          patchPayload = data;
        }).thenRespond({
            status: 200,
            json: {
              id: 'gist_id',
              description: 'strkio::set',
              owner: {
                login: 'bob'
              },
              files: {
                _meta: {
                  content: '{"version": "4"}'
                },
                'streak_name': {
                  content: stringify(
                    {name: 'streak_name', description: '',
                      data: {'2012-12-24': 2, '2012-12-25': 2}}
                  )
                },
                'another_streak_name': {
                  content: stringify({
                    name: 'another_streak_name',
                    description: 'another_streak_description',
                    data: {}
                  })
                }
              }
            }
          });
        new GitHubGist({id: 'gist_id'}).fetch(function (err, self) {
          expect(err).to.be.null;
          expect(patchPayload).to.be.deep.equal({
            description: 'strkio::set',
            files: {
              '_meta': {
                content: stringify({version: 4})
              },
              'streak_name': {
                content: stringify(
                  {name: 'streak_name', description: '',
                    data: {'2012-12-24': 2, '2012-12-25': 2}}
                )
              },
              'another_streak_name': {
                content: stringify({
                  name: 'another_streak_name',
                  description: 'another_streak_description',
                  data: {}
                })
              }
            }
          });
          expect(self.data).to.be.deep.equal({
            id: 'gist_id',
            owner: 'bob',
            version: '4',
            streaks: [{
              name: 'another_streak_name',
              description: 'another_streak_description',
              data: {}
            }, {
              name: 'streak_name',
              description: '',
              data: {
                '2012-12-24': 2, '2012-12-25': 2
              }
            }]
          });
          github.expectNoMoreInteractions();
          done();
        });
      });
  });

  describe('#diff()', function () {

    it('should return diff compatible with patch', function () {
      var data = {
        streaks: [
          {name: 'streak_1', description: 'description'},
          {
            name: 'streak_2',
            data: {'2014-12-24': 0, '2014-12-26': 2, '2014-12-28': 1}
          },
          {name: 'streak_3'}
        ]
      };
      var diff = new GitHubGist(data).diff({
        streaks: [
          {name: 'streak_1', description: 'updated_description'},
          {
            name: 'streak_2',
            data: {
              '2014-12-24': 1, '2014-12-25': 1, '2014-12-26': 1
            }
          }
        ]
      });
      expect(diff).to.be.deep.equal({
        'streak_1': {
          description: 'updated_description'
        },
        'streak_2': {
          data: {
            '2014-12-24': '+1',
            '2014-12-25': '+1',
            '2014-12-26': '-1',
            '2014-12-28': '-1'
          }
        },
        'streak_3': null
      });
    });

  });

  describe('#patch()', function () {

    it('should update internal data using diff', function () {
      var data = {
        streaks: [
          {name: 'streak_1', description: 'description'},
          {
            name: 'streak_2',
            data: {'2014-12-24': 0, '2014-12-26': 2}
          },
          {name: 'streak_3'}
        ]
      };
      var updatedData = new GitHubGist(data).patch({
        'streak_1': {
          description: 'updated_description'
        },
        'streak_2': {
          data: {
            '2014-12-24': '+1',
            '2014-12-25': 1,
            '2014-12-26': '-1'
          }
        },
        'streak_3': null,
        'streak_4': {
          data: {
            '2014-12-26': '-1'
          }
        }
      });
      expect(updatedData).to.be.deep.equal({
        streaks: [
          {name: 'streak_1', description: 'updated_description'},
          {
            name: 'streak_2',
            data: {
              '2014-12-24': 1, '2014-12-25': 1, '2014-12-26': 1
            }
          },
          {name: 'streak_4', data: {'2014-12-26': -1}}
        ]
      });
    });

  });

});
