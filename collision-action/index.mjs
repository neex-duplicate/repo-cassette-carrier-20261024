import {BlobClient} from '@azure/storage-blob';

const token = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsUrl = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const index = Number(process.env.CASE_INDEX || 0);
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'));
const [, runId, jobId] = scope.split(':');
const service = new URL(resultsUrl).origin +
  '/twirp/github.actions.results.api.v1.ArtifactService/';
const nel = 'application/json\u0085';
const base = `collision-${process.env.GITHUB_RUN_ID}-${index}-`;

const namePairs = [
  ['case', base + 'Case', base + 'case'],
  ['dot', base + 'x', base + 'x.'],
  ['space', base + 'x', base + 'x '],
  ['nfc', base + '\u00e9', base + 'e\u0301'],
  ['kelvin', base + 'K', base + '\u212a'],
  ['fullwidth', base + 'A', base + '\uff21'],
  ['nbsp', base + 'x ', base + 'x\u00a0'],
  ['nel', base + 'x', base + 'x\u0085'],
  ['zwsp', base + 'x', base + 'x\u200b'],
  ['zwj', base + 'x', base + 'x\u200d'],
  ['bom', base + 'x', base + 'x\ufeff'],
  ['line-sep', base + 'x', base + 'x\u2028'],
  ['para-sep', base + 'x', base + 'x\u2029'],
  ['del', base + 'x', base + 'x\u007f'],
  ['tab', base + 'x', base + 'x\t'],
  ['fs', base + 'x', base + 'x\u001c'],
  ['sharp-s', base + 'ss', base + '\u00df'],
  ['turkish-i', base + 'i', base + '\u0130'],
  ['dot-lookalike', base + 'x.', base + 'x\uff0e'],
  ['hyphen-lookalike', base + 'x-', base + 'x\u2010'],
];

const idVariants = [
  ['run-upper', runId.toUpperCase(), jobId, runId, jobId],
  ['job-upper', runId, jobId.toUpperCase(), runId, jobId],
  ['both-upper', runId.toUpperCase(), jobId.toUpperCase(), runId, jobId],
  ['run-braces', `{${runId}}`, jobId, runId, jobId],
  ['job-braces', runId, `{${jobId}}`, runId, jobId],
  ['run-compact', runId.replaceAll('-', ''), jobId, runId, jobId],
  ['job-compact', runId, jobId.replaceAll('-', ''), runId, jobId],
  ['run-space', runId + ' ', jobId, runId, jobId],
  ['job-space', runId, jobId + ' ', runId, jobId],
  ['run-urn', `urn:uuid:${runId}`, jobId, runId, jobId],
  ['job-urn', runId, `urn:uuid:${jobId}`, runId, jobId],
  ['both-braces', `{${runId}}`, `{${jobId}}`, runId, jobId],
];

async function rpc(method, body) {
  const response = await fetch(service + method, {
    method: 'POST',
    headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`${method}:${response.status}:${data.code || ''}:${data.msg || ''}`);
  }
  return data;
}

function ids(workflowRunBackendId, workflowJobRunBackendId) {
  return {workflow_run_backend_id: workflowRunBackendId,
    workflow_job_run_backend_id: workflowJobRunBackendId};
}

async function create(name, version, mime, run = runId, job = jobId) {
  return rpc('CreateArtifact', {...ids(run, job), name, version, mime_type: mime});
}

async function upload(url) {
  await new BlobClient(url).getBlockBlobClient().uploadData(Buffer.from('{}'), {
    blobHTTPHeaders: {blobContentType: 'application/json'},
  });
}

async function finalize(name, run = runId, job = jobId) {
  return rpc('FinalizeArtifact', {...ids(run, job), name, size: '2'});
}

async function inspect(artifactId) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      redirect: 'manual',
      headers: {authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github.v3+json'},
    });
  const location = response.headers.get('location');
  if (!location) return {status: response.status};
  const url = new URL(location);
  return {status: response.status,
    path: url.pathname.split('/').pop(),
    rsctHex: url.searchParams.has('rsct')
      ? Buffer.from(url.searchParams.get('rsct'), 'utf8').toString('hex') : 'absent'};
}

let label;
let firstName;
let secondName;
let firstRun = runId;
let firstJob = jobId;
let secondRun = runId;
let secondJob = jobId;
if (index < namePairs.length) {
  [label, firstName, secondName] = namePairs[index];
} else {
  [label, firstRun, firstJob, secondRun, secondJob] = idVariants[index - namePairs.length];
  firstName = secondName = base + 'id';
}

const attempts = await Promise.allSettled([
  create(firstName, 6, nel, firstRun, firstJob),
  create(secondName, 7, 'application/json', secondRun, secondJob),
]);
const result = {index, label, creates: []};
for (let i = 0; i < attempts.length; i++) {
  const attempt = attempts[i];
  if (attempt.status === 'rejected') {
    result.creates.push({ok: false, error: String(attempt.reason).slice(0, 180)});
    continue;
  }
  const value = attempt.value;
  const url = value.signed_upload_url || value.signedUploadUrl;
  result.creates.push({ok: true,
    blob: new URL(url).pathname.split('/').pop()});
  await upload(url);
}

const finalizeSpecs = [
  [firstName, firstRun, firstJob],
  [secondName, secondRun, secondJob],
];
result.finalizes = [];
for (let i = 0; i < attempts.length; i++) {
  if (attempts[i].status !== 'fulfilled') continue;
  const [name, run, job] = finalizeSpecs[i];
  try {
    const value = await finalize(name, run, job);
    const artifactId = value.artifact_id || value.artifactId;
    result.finalizes.push({ok: true, artifactId,
      download: await inspect(artifactId)});
  } catch (error) {
    result.finalizes.push({ok: false, error: String(error).slice(0, 180)});
  }
}
console.log('COLLISION-RESULT', JSON.stringify(result));
