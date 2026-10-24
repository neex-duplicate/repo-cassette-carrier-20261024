import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';
import {BlobClient} from '@azure/storage-blob';
import {createHash} from 'node:crypto';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const stamp = process.env.GITHUB_RUN_ID;
const candidates = [
  ['plain', `edge-${stamp}`],
  ['amp-api', `edge&api-version=2012-02-12-${stamp}`],
  ['question-api', `edge?api-version=2012-02-12-${stamp}`],
  ['hash-api', `edge#api-version=2012-02-12-${stamp}`],
  ['semi-api', `edge;api-version=2012-02-12-${stamp}`],
  ['pct-amp-api', `edge%26api-version%3D2012-02-12-${stamp}`],
  ['pct-question-api', `edge%3Fapi-version%3D2012-02-12-${stamp}`],
  ['double-pct-api', `edge%2526api-version%253D2012-02-12-${stamp}`],
  ['amp-rsct-api', `edge&rsct=application%2Fjson%85&api-version=2012-02-12-${stamp}`],
  ['pct-rsct-api', `edge%26rsct%3Dapplication%252Fjson%2585%26api-version%3D2012-02-12-${stamp}`],
  ['equals-api', `edge=api-version=2012-02-12-${stamp}`],
  ['plus-api', `edge+api-version=2012-02-12-${stamp}`],
  ['comma-api', `edge,api-version=2012-02-12-${stamp}`],
  ['nel-api', `edge\u0085&api-version=2012-02-12-${stamp}`],
  ['quote-api', `edge"&api-version=2012-02-12-${stamp}`],
];

const report = [];
for (let i = 0; i < candidates.length; i++) {
  const [label, name] = candidates[i];
  const mime = 'application/json';
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
