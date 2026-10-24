import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';
import {internalArtifactTwirpClient} from '../node_modules/@actions/artifact/lib/internal/shared/artifact-twirp-client.js';
import {getBackendIdsFromToken} from '../node_modules/@actions/artifact/lib/internal/shared/util.js';
import {StringValue} from '../node_modules/@actions/artifact/lib/generated/index.js';

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const body = Buffer.from('{"probe":"control-name"}');
const hash = createHash('sha256').update(body).digest('hex');
const codePoints = [
  ...Array.from({length: 0x20}, (_, index) => index),
  0x7f,
  ...Array.from({length: 0x20}, (_, index) => 0x80 + index),
  0x2028, 0x2029,
];

async function probe(codePoint) {
  const hex = codePoint.toString(16).padStart(4, '0');
  const name = `ctrl-${hex}-${String.fromCodePoint(codePoint)}-x.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({value: 'application/json'}),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: {blobContentType: 'application/json\x85'},
    });
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(body.length),
      hash: StringValue.create({value: `sha256:${hash}`}),
    });
    return {
      hex,
      ok: true,
      artifactId: finalized.artifactId,
      nameBase64: Buffer.from(name).toString('base64'),
    };
  } catch (error) {
    return {hex, ok: false, error: String(error).split(': ').at(-1).slice(0, 160)};
  }
}

const report = [];
for (let offset = 0; offset < codePoints.length; offset += 8) {
  report.push(...await Promise.all(codePoints.slice(offset, offset + 8).map(probe)));
}
console.log(`CONTROL_REPORT ${JSON.stringify(report)}`);
