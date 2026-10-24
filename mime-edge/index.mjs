import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {BlobClient} from '@azure/storage-blob';
import {createHash} from 'node:crypto';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const base = 'application/json';
const candidates = [
  ['pct85', `${base}%85`],
  ['pctc285', `${base}%C2%85`],
  ['pctc285-low', `${base}%c2%85`],
  ['pctu0085', `${base}%u0085`],
  ['pct2585', `${base}%2585`],
  ['pct25c285', `${base}%25C2%2585`],
  ['pctslash85', `application%2Fjson%85`],
  ['pctslashc285', `application%2Fjson%C2%85`],
  ['pct-raw-slash', `application%2fjson%85`],
  ['pluspct85', `${base}+%85`],
  ['pct85-param', `${base};x=%85`],
  ['pctc285-param', `${base};x=%C2%85`],
  ['pct85-quoted', `${base};x="%85"`],
  ['pct0a', `${base}%0A`],
  ['pct0d', `${base}%0D`],
  ['pct00', `${base}%00`],
];

const report = [];
for (let i = 0; i < candidates.length; i++) {
  const [label, mime] = candidates[i];
  const name = `mime-edge-${process.env.GITHUB_RUN_ID}-${i}`;
  try {
    const result = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: mime}),
    });
    const body = Buffer.from(JSON.stringify({label, mime}));
    await new BlobClient(result.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: 'application/octet-stream'},
    });
    const hash = createHash('sha256').update(body).digest('hex');
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(body.length),
      hash: StringValue.create({value: `sha256:${hash}`}),
    });
    report.push({label, name, mime, hex: Buffer.from(mime).toString('hex'), ok: result.ok,
      artifactId: finalized.artifactId,
      path: new URL(result.signedUploadUrl).pathname.split('/').pop()});
  } catch (error) {
    report.push({label, hex: Buffer.from(mime).toString('hex'), error: String(error).split(': ').at(-1)});
  }
}
console.log(`MIME_EDGE ${JSON.stringify(report)}`);
