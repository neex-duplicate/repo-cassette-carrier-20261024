import {createHash} from 'node:crypto';
import https from 'node:https';

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(new Error('response exceeded one MiB'));
          return;
        }
        chunks.push(chunk);
      });
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

const apiHeaders = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  'user-agent': 'repo-cassette-post-job-step-observer',
  'x-github-api-version': '2022-11-28',
};
const jobsUrl = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
  `/actions/runs/${process.env.GITHUB_RUN_ID}/jobs`;
const jobsResponse = await request(jobsUrl, {headers: apiHeaders});
if (jobsResponse.status !== 200) {
  throw new Error(`job lookup returned ${jobsResponse.status}`);
}
const jobs = JSON.parse(jobsResponse.body).jobs || [];
const carrier = jobs.find(job => job.name === 'carrier');
if (!carrier?.id) throw new Error('completed carrier job was not found');

const stepNumber = 3;
const repository = `x/../${process.env.GITHUB_REPOSITORY}` +
  `/actions/jobs/${carrier.id}/steps/${stepNumber}/logs`;
const payload = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette bound step-log carrier',
  stargazers_count: 0,
}));
const route = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
  `/actions/jobs/${carrier.id}/steps/${stepNumber}/logs`;

let observation = {apiStatus: null};
for (let attempt = 0; attempt < 20; attempt++) {
  const api = await request(route, {headers: apiHeaders});
  observation = {apiStatus: api.status};
  if (api.status === 302 && api.headers.location) {
    const signed = new URL(api.headers.location);
    let target = await request(signed, {
      headers: {'user-agent': 'repo-cassette-post-job-step-observer'},
    });
    let redirectCount = 0;
    while (target.status >= 300 && target.status < 400 &&
           target.headers.location && redirectCount++ < 2) {
      target = await request(new URL(target.headers.location, signed), {
        headers: {'user-agent': 'repo-cassette-post-job-step-observer'},
      });
    }
    const contentType = target.headers['content-type'] || '';
    observation = {
      apiStatus: api.status,
      signedHost: signed.host,
      signedPathSuffix: signed.pathname.split('/').at(-1),
      rsctHex: Buffer.from(signed.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      targetStatus: target.status,
      contentTypeHex: Buffer.from(contentType, 'latin1').toString('hex'),
      bodyBytes: target.body.length,
      bodySha256: createHash('sha256').update(target.body).digest('hex'),
      bodyMatches: target.body.equals(payload),
    };
    if (target.status === 200) break;
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}

console.log('POST_JOB_STEP_QUALIFY', JSON.stringify({
  jobId: carrier.id,
  stepNumber,
  repository,
  expectedBytes: payload.length,
  expectedSha256: createHash('sha256').update(payload).digest('hex'),
  ...observation,
}));
