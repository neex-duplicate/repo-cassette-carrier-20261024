import https from 'node:https';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      response.resume();
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
      }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

const headers = {
  accept: 'application/vnd.github.v3+json',
  authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  'user-agent': 'repo-cassette-redirect-query-probe',
};
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
  `/actions/artifacts/${process.env.ARTIFACT_ID}/zip`;
const cases = [
  ['none', ''],
  ['unrelated', '?probe=cassette'],
  ['rsct-utf8-nel', '?rsct=application%2Fjson%C2%85'],
  ['rsct-byte85', '?rsct=application%2Fjson%85'],
  ['api-rsct-byte85', '?api-version=2012-02-12&rsct=application%2Fjson%85'],
  ['encoded-name', '?%72%73%63%74=application%2Fjson%85'],
  ['duplicate-rsct', '?rsct=application%2Fjson&rsct=application%2Fjson%85'],
];
const report = [];
for (const [label, query] of cases) {
  const response = await request(base + query, {headers});
  const item = {label, status: response.status};
  if (response.headers.location) {
    const location = new URL(response.headers.location);
    item.targetExtension = location.pathname.split('.').at(-1);
    item.queryKeys = [...new Set([...location.searchParams.keys()])].sort();
    item.rsctHex = location.searchParams.getAll('rsct').map(value =>
      Buffer.from(value, 'utf8').toString('hex'));
  }
  report.push(item);
}
console.log('REDIRECT_QUERY_QUALIFY', JSON.stringify(report));
