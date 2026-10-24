import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {BlobClient} from '@azure/storage-blob';
import {createHash} from 'node:crypto';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const body = Buffer.from('{}');
const hash = createHash('sha256').update(body).digest('hex');

async function make(name, version) {
  const mime = version === 7 ? 'application/json' : 'application/json\u0085';
  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
  await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {
    blobHTTPHeaders: {blobContentType: 'application/json'},
  });
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(body.length),
    hash: StringValue.create({value: `sha256:${hash}`}),
  });
  return {
    id: finalized.artifactId,
    version,
    file: new URL(created.signedUploadUrl).pathname.split('/').at(-1),
  };
}

async function erase(name) {
  return client.DeleteArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
  });
}

async function probe(artifact, phase, index) {
  const url = `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip?race=${phase}-${index}-${Math.random()}`;
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github.v3+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'repo-cassette-race-probe',
      },
    });
    const location = response.headers.get('location');
    if (!location) return {status: response.status};
    const target = new URL(location);
    return {
      status: response.status,
      ext: target.pathname.split('.').at(-1),
      rsct: target.searchParams.get('rsct'),
      blob: target.pathname.split('/').at(-1),
    };
  } catch (error) {
    return {error: String(error)};
  }
}

function anomalous(artifact, result) {
  if (result.status !== 302) return false;
  const expectedExt = artifact.version === 7 ? 'json' : 'zip';
  const expectedType = artifact.version === 7 ? 'application/json' : 'application/zip';
  return result.ext !== expectedExt || result.rsct !== expectedType ||
    result.blob !== artifact.file;
}

const anomalies = [];
const summaries = new Map();
const name = `delete-race-${process.env.GITHUB_RUN_ID}`;
for (let round = 0; round < 12; round++) {
  const first = await make(name, round % 2 === 0 ? 6 : 7);
  const requests = Array.from({length: 12}, (_, index) => probe(first, `a${round}`, index));
  const transition = (async () => {
    await erase(name);
    return make(name, first.version === 7 ? 6 : 7);
  })();
  const firstResults = await Promise.all(requests);
  const second = await transition;
  for (const result of firstResults) {
    const key = JSON.stringify([first.version, result.status, result.ext, result.rsct,
      result.blob === first.file]);
    summaries.set(key, (summaries.get(key) || 0) + 1);
    if (anomalous(first, result)) anomalies.push({round, phase: 'old', first, second, result});
  }

  const secondRequests = Array.from({length: 12}, (_, index) => probe(second, `b${round}`, index));
  const deletion = erase(name);
  const secondResults = await Promise.all(secondRequests);
  await deletion;
  for (const result of secondResults) {
    const key = JSON.stringify([second.version, result.status, result.ext, result.rsct,
      result.blob === second.file]);
    summaries.set(key, (summaries.get(key) || 0) + 1);
    if (anomalous(second, result)) anomalies.push({round, phase: 'new', first, second, result});
  }
}

console.log(`DELETE_RACE ${JSON.stringify({summaries: [...summaries], anomalies})}`);
