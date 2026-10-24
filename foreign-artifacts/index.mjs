import {createHash} from 'node:crypto';
import https from 'node:https';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

const repository = 'yujeong050720/repo-cassette-private';
const artifactIds = ['12564864913', '12565850244', '12565103673', '12564914591'];
const report = [];
for (const artifactId of artifactIds) {
  const route = `${repository}/actions/artifacts/${artifactId}/zip`;
  const expected = Buffer.from(JSON.stringify({
    full_name: route,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette private artifact',
    stargazers_count: 0,
  }));
  const api = await request(`https://api.github.com/repos/${route}`, {headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-working-artifact-qualification',
  }});
  const item = {artifactId, apiStatus: api.status,
    expectedBytes: expected.length,
    expectedSha256: createHash('sha256').update(expected).digest('hex')};
  if (api.status === 302 && api.headers.location) {
    const signed = new URL(api.headers.location);
    const target = await request(signed, {headers: {
      'user-agent': 'repo-cassette-working-artifact-qualification',
    }});
    Object.assign(item, {
      targetExtension: signed.pathname.split('.').at(-1),
      rsctHex: Buffer.from(signed.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      targetStatus: target.status,
      contentTypeHex: Buffer.from(target.headers['content-type'] || '', 'latin1').toString('hex'),
      bodyBytes: target.body.length,
      bodySha256: createHash('sha256').update(target.body).digest('hex'),
      bodyMatches: target.body.equals(expected),
    });
  }
  report.push(item);
}
console.log('FOREIGN_ARTIFACT_QUALIFY', JSON.stringify(report));
