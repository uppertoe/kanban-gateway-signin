// Stand-in for the gateway members endpoint (GET /v1/groups/<group>/members),
// for the board-groups check in run.sh. Each group's members are read from
// /data/<group>.json at every request; a file holding "fail" answers 500 and
// a missing file answers 403, as the gateway does for a group it will not give.
const fs = require('fs');
const http = require('http');

http
  .createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${process.env.MEMBERS_TOKEN}`) {
      res.writeHead(401);
      return res.end();
    }
    const match = req.url.match(/^\/v1\/groups\/([^/]+)\/members$/);
    if (!match) {
      res.writeHead(404);
      return res.end();
    }
    const group = decodeURIComponent(match[1]);
    const file = `/data/${group}.json`;
    if (!fs.existsSync(file)) {
      res.writeHead(403);
      return res.end();
    }
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text === 'fail') {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ group, members: JSON.parse(text), as_of: new Date().toISOString() }));
  })
  .listen(8081);
