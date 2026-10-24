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

const jobId = process.env.CARRIER_JOB_ID;
const stepNumber = 3;
if (!/^\d+$/.test(jobId || '')) throw new Error('carrier job ID is invalid');
const repository = `x/../${process.env.GITHUB_REPOSITORY}` +
  `/actions/jobs/${jobId}/steps/${stepNumber}/logs`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette bound step-log carrier',
  stargazers_count: 0,
}));
const route = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
  `/actions/jobs/${jobId}/steps/${stepNumber}/logs`;
const variants = [
  ['default', {}],
  ['v2022', {'x-github-api-version': '2022-11-28'}],
];
const report = [];
for (const [label, extra] of variants) {
  const api = await request(route, {headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-existing-step-observer',
    ...extra,
  }});
  const result = {label, apiStatus: api.status};
  if (api.status === 302 && api.headers.location) {
    const signed = new URL(api.headers.location);
    const target = await request(signed, {headers: {
      'user-agent': 'repo-cassette-existing-step-observer',
    }});
    const contentType = target.headers['content-type'] || '';
    Object.assign(result, {
      signedHost: signed.host,
      signedPathSuffix: signed.pathname.split('/').at(-1),
      rsctHex: Buffer.from(signed.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      targetStatus: target.status,
      contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
      bodyBytes: target.body.length,
      bodySha256: createHash('sha256').update(target.body).digest('hex'),
      bodyMatches: target.body.equals(expected),
    });
  }
  report.push(result);
}
console.log('EXISTING_STEP_QUALIFY', JSON.stringify({
  jobId,
  stepNumber,
  repository,
  expectedBytes: expected.length,
  expectedSha256: createHash('sha256').update(expected).digest('hex'),
  report,
}));
